/** Local and computer-qualified filesystem dispatch; foreign targets never fall back to local paths. */
import { Context } from '@deepseek-ai/cordis'
import { posix, win32 } from 'node:path'
import { pathToFileURL } from 'node:url'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FileSystem, FsTarget, FsDirEntry, FsInfo, FsPathInfo } from '@deepseek-ai/dsh-fs'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import { SshFileSystem } from '@deepseek-ai/dsh-fs-ssh'
import { remoteDirectory, remoteDirectoryOf } from '@deepseek-ai/dsh-util-workspace-path'
import { z } from 'zod'
import type { ComputerId } from './types.ts'
import type {} from './index.ts'

function mapTargets(value: unknown, convert: (path: string) => string): unknown {
  if (Array.isArray(value)) return value.map(item => mapTargets(item, convert))
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      key === 'targetKey' && typeof item === 'string' ? convert(item) : mapTargets(item, convert),
    ]),
  )
}

/** Computer-specific filesystem using the existing typed file RPC consumer. */
export class RemoteFileSystem extends SshFileSystem {
  static override inject = ['remoteWork', 'sandboxPolicy']
  /** @param ctx - isolated filesystem context.
   * @param config - stable computer identity.
   */
  constructor(
    ctx: Context,
    private readonly remote: { computerId: ComputerId },
  ) {
    super(ctx)
  }

  override processPath(target: FsTarget): string {
    const location = remoteDirectoryOf(String(target.targetKey))
    if (location?.computerId !== this.remote.computerId)
      throw new FsError('File belongs to a different execution computer', 'FS_IO_ERROR')
    return location.path
  }

  override fileUrl(target: FsTarget): string {
    const path = this.processPath(target)
    return pathToFileURL(path, { windows: /^[A-Za-z]:[/\\]/u.test(path) || path.startsWith('\\\\') }).href
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    const base = this.processPath(parent)
    const api = /^[A-Za-z]:[/\\]/u.test(base) || base.startsWith('\\\\') ? win32 : posix
    const relative = api.relative(base, this.processPath(child))
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${api.sep}`) && !api.isAbsolute(relative))
  }

  override async readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    let text = ''
    for await (const chunk of await this.streamText(target, signal)) text += chunk
    return text
  }

  override async readBytes(target: FsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    const chunks: Buffer[] = []
    let bytes = 0
    while (true) {
      const chunk = Buffer.from(
        await this.readByteRange(
          target,
          { offset: bytes, length: Math.min(this.ctx.remoteWork.transferBytes, maxBytes - bytes + 1) },
          signal,
        ),
      )
      if (chunk.length === 0) return Buffer.concat(chunks)
      bytes += chunk.length
      if (bytes > maxBytes) throw new FsError('Remote file exceeds the requested byte limit', 'FS_TOO_LARGE')
      chunks.push(chunk)
    }
  }

  override streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    const length = this.ctx.remoteWork.transferBytes
    const read = (offset: number): Promise<Uint8Array> => this.readByteRange(target, { offset, length }, signal)
    return Promise.resolve(
      (async function* () {
        const decoder = new TextDecoder('utf-8', { fatal: true })
        let offset = 0
        while (true) {
          const bytes = await read(offset)
          if (bytes.length === 0) break
          if (bytes.includes(0)) throw new FsError('File contains binary content', 'FS_NOT_TEXT')
          yield decoder.decode(bytes, { stream: true })
          offset += bytes.length
        }
        const final = decoder.decode()
        if (final !== '') yield final
      })(),
    )
  }

  override async watch(
    target: FsTarget,
    changed: (error?: Error) => void,
    signal: AbortSignal,
  ): Promise<() => Promise<void>> {
    const controller = new AbortController()
    const control = AbortSignal.any([signal, controller.signal])
    let version = (await this.stat(target, control))?.version
    const loop = (async () => {
      while (!control.aborted) {
        await this.ctx.remoteWork.waitForPoll(control)
        const next = (await this.stat(target, control))?.version
        if (next !== version) {
          version = next
          changed()
        }
      }
    })().catch((error: unknown) => {
      if (!control.aborted) changed(error instanceof Error ? error : new Error(String(error)))
    })
    return async () => {
      controller.abort()
      await loop
    }
  }

  protected override async call<T>(
    method: string,
    params: unknown,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const unwrapped = mapTargets(params, (path) => {
      const location = remoteDirectoryOf(path)
      if (location?.computerId !== this.remote.computerId)
        throw new FsError('Invalid remote filesystem identity', 'FS_IO_ERROR')
      return location.path
    })
    const raw = typeof unwrapped === 'object' && unwrapped !== null ? { ...unwrapped } : unwrapped
    if (
      raw !== null &&
      typeof raw === 'object' &&
      'policy' in raw &&
      raw.policy !== null &&
      typeof raw.policy === 'object' &&
      'workspaceRoot' in raw.policy &&
      typeof raw.policy.workspaceRoot === 'string'
    ) {
      raw.policy.workspaceRoot = remoteDirectoryOf(raw.policy.workspaceRoot)?.path ?? raw.policy.workspaceRoot
    }
    try {
      const value = await this.ctx.remoteWork
        .connection(this.remote.computerId)
        .request(
          method,
          raw,
          schema,
          signal,
          /^(?:fs\.(?:resolve|stat|lstat|list|readText|readBytes|readRange))$/u.test(method),
        )
      return mapTargets(value, path => remoteDirectory(this.remote.computerId, path)) as T
    } catch (error) {
      if (error instanceof Error && 'code' in error && typeof error.code === 'string' && error.code.startsWith('FS_')) {
        throw new FsError(error.message, error.code as FsError['code'], { cause: error })
      }
      throw error
    }
  }
}

/** Host filesystem provider with explicit remote target identities and initiator-selected resolution. */
export class RoutedFileSystem extends SandboxedFileSystem {
  static override inject = ['sandboxPolicy', 'remoteWork', 'agents']
  private remoteFor(target: FsTarget): RemoteFileSystem | undefined {
    const location = remoteDirectoryOf(String(target.targetKey))
    return location === undefined ? undefined : this.ctx.remoteWork.filesystem(location.computerId as ComputerId)
  }

  private remoteRequest(path: string, opts?: { cwd?: string }) {
    const explicit = remoteDirectoryOf(path)
    const base = opts?.cwd === undefined ? undefined : remoteDirectoryOf(opts.cwd)
    const agent = this.ctx.agents.currentInitiator()
    const project = agent?.session.header.cwd === undefined ? undefined : remoteDirectoryOf(agent.session.header.cwd)
    if (
      (agent !== undefined &&
        ((explicit !== undefined && explicit.computerId !== project?.computerId) ||
          (base !== undefined && base.computerId !== project?.computerId))) ||
      (opts?.cwd !== undefined &&
        explicit !== undefined &&
        explicit.computerId !== (base?.computerId ?? project?.computerId))
    ) {
      throw new FsError('A file path cannot select a different execution computer', 'FS_IO_ERROR')
    }
    if (agent?.session.header.cwd?.startsWith('dsh-') === true && project === undefined) {
      throw new FsError('The Session requires an unavailable execution filesystem provider', 'FS_IO_ERROR')
    }
    if (/^dsh-[a-z][a-z0-9+.-]*:/u.test(path) && explicit === undefined)
      throw new FsError('Invalid execution directory address', 'FS_IO_ERROR')
    const selected = explicit ?? base ?? project
    if (selected === undefined) return undefined
    return {
      fs: this.ctx.remoteWork.filesystem(selected.computerId as ComputerId),
      path: explicit?.path ?? path,
      cwd: base?.path ?? opts?.cwd ?? this.ctx.remoteWork.workingDirectory(agent, selected.path),
    }
  }

  override resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    const remote = this.remoteRequest(path, opts)
    return remote === undefined
      ? super.resolve(path, opts)
      : remote.fs.resolve(remote.path, { ...opts, cwd: remote.cwd })
  }

  override processPathFromHostPath(hostPath: string): string | undefined {
    const agent = this.ctx.agents.currentInitiator()
    if (agent?.session.header.cwd !== undefined && remoteDirectoryOf(agent.session.header.cwd) !== undefined)
      return undefined
    return super.processPathFromHostPath(hostPath)
  }
  override processPath(target: FsTarget): string {
    return this.remoteFor(target)?.processPath(target) ?? super.processPath(target)
  }
  override fileUrl(target: FsTarget): string {
    return this.remoteFor(target)?.fileUrl(target) ?? super.fileUrl(target)
  }
  override contains(parent: FsTarget, child: FsTarget): boolean {
    const remote = this.remoteFor(parent)
    if (remote === undefined) return this.remoteFor(child) === undefined && super.contains(parent, child)
    const parentLocation = remoteDirectoryOf(String(parent.targetKey))
    if (remoteDirectoryOf(String(child.targetKey))?.computerId !== parentLocation?.computerId) return false
    return remote.contains(parent, child)
  }
  override stat(target: FsTarget, signal?: AbortSignal): Promise<FsInfo | undefined> {
    return this.remoteFor(target)?.stat(target, signal) ?? super.stat(target, signal)
  }
  override listDir(target: FsTarget, signal?: AbortSignal): Promise<FsDirEntry[]> {
    return this.remoteFor(target)?.listDir(target, signal) ?? super.listDir(target, signal)
  }
  override readText(target: FsTarget, signal?: AbortSignal): Promise<string> {
    return this.remoteFor(target)?.readText(target, signal) ?? super.readText(target, signal)
  }
  override streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>> {
    return this.remoteFor(target)?.streamText(target, signal) ?? super.streamText(target, signal)
  }
  /** @param args - Original target, cancellation, and byte cap from FileSystem.readBytes. */
  override readBytes(...args: Parameters<FileSystem['readBytes']>): ReturnType<FileSystem['readBytes']> {
    return this.remoteFor(args[0])?.readBytes(...args) ?? super.readBytes(...args)
  }
  /** @param args - Original target, byte window, and cancellation from FileSystem.readByteRange. */
  override readByteRange(...args: Parameters<FileSystem['readByteRange']>): ReturnType<FileSystem['readByteRange']> {
    return this.remoteFor(args[0])?.readByteRange(...args) ?? super.readByteRange(...args)
  }
  /** @param args - Original target, content, version intent, cancellation, and policy. */
  override writeText(...args: Parameters<FileSystem['writeText']>): ReturnType<FileSystem['writeText']> {
    return this.remoteFor(args[0])?.writeText(...args) ?? super.writeText(...args)
  }
  /** @param args - Original target, edit, version guard, cancellation, and policy. */
  override editText(...args: Parameters<FileSystem['editText']>): ReturnType<FileSystem['editText']> {
    return this.remoteFor(args[0])?.editText(...args) ?? super.editText(...args)
  }
  /** @param args - Original target, patch hunks, version guard, cancellation, and policy. */
  override patchText(...args: Parameters<FileSystem['patchText']>): ReturnType<FileSystem['patchText']> {
    return this.remoteFor(args[0])?.patchText(...args) ?? super.patchText(...args)
  }
  /** @param args - Original target, version guard, cancellation, and policy. */
  override deleteFile(...args: Parameters<FileSystem['deleteFile']>): ReturnType<FileSystem['deleteFile']> {
    return this.remoteFor(args[0])?.deleteFile(...args) ?? super.deleteFile(...args)
  }
  /** @param args - Original source, destination, options, cancellation, and policy; both targets must share a computer. */
  override moveFile(...args: Parameters<FileSystem['moveFile']>): ReturnType<FileSystem['moveFile']> {
    const remote = this.remoteFor(args[0])
    if (
      remoteDirectoryOf(String(args[0].targetKey))?.computerId !==
      remoteDirectoryOf(String(args[1].targetKey))?.computerId
    )
      throw new FsError('Cannot move files between computers', 'FS_IO_ERROR')
    return remote?.moveFile(...args) ?? super.moveFile(...args)
  }
  override async lstat(path: string, opts?: { cwd?: string }, signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    const remote = this.remoteRequest(path, opts)
    return remote === undefined
      ? super.lstat(path, opts, signal)
      : remote.fs.lstat(remote.path, { cwd: remote.cwd }, signal)
  }
  /** @param args - Original target and watch options, including cancellation and notifications. */
  override watch(...args: Parameters<FileSystem['watch']>): ReturnType<FileSystem['watch']> {
    return this.remoteFor(args[0])?.watch(...args) ?? super.watch(...args)
  }
}
