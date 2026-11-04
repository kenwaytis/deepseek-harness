/** User-owned remote execution daemon. SSH transports attach to it without owning its processes. */
import { randomUUID, type KeyObject } from 'node:crypto'
import { createServer, type Server, type Socket } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { writeFile, mkdir, rename } from 'node:fs/promises'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SandboxedFileSystem } from '@deepseek-ai/dsh-fs-sandbox'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { OutputCollector } from '@deepseek-ai/dsh-subprocess-local/output'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'
import { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { SshRpcPeer, RemoteOperationError } from '@deepseek-ai/dsh-ssh/protocol'
import { spawnSchema, policySchema } from '@deepseek-ai/dsh-ssh/schemas'
import { z } from 'zod'
import { runtimeFileOperation } from './runtime-files.ts'
import { authenticateRuntimeServer, createRuntimeIdentity, runtimePublicKey } from './authentication.ts'

const idInput = z.object({ id: z.uuid() }).strict()
const invocation = z.object({ id: z.uuid(), method: z.string(), params: z.unknown() }).strict()

interface ProcessRecord {
  readonly id: string
  readonly handle: SubprocessHandle | SubprocessTerminalHandle
  readonly terminal: boolean
  readonly output: Record<'stdout' | 'stderr' | 'control' | 'terminal', OutputCollector>
  quiescent: boolean
  outcome?: SubprocessOutcome
  error?: string
}

/** Limits travel in the installed private configuration, not through model arguments. */
export interface RuntimeConfig {
  readonly root: string
  readonly authorizedKey: string
  readonly version: string
  readonly maxProcesses: number
  readonly maxOutputBytes: number
  readonly readChunkBytes: number
  readonly maxRememberedOperations: number
  readonly maxFrameBytes: number
  readonly authenticationTimeoutMs: number
  readonly maxConnections: number
}

/** Owns authenticated clients, filesystem effects, processes and recovery results for one daemon generation. */
export class RemoteExecutionServer {
  /** Distinguishes recoverable in-memory state from a restarted daemon. */
  readonly instance = randomUUID()
  private readonly identity = createRuntimeIdentity()
  /** Public endpoint identity; its private key exists only in this daemon's memory. */
  readonly publicKey = this.identity.publicKey
  private readonly authorizedKey: KeyObject
  private readonly ctx = new Context()
  private readonly processes = new Map<string, ProcessRecord>()
  private readonly operations = new Map<string, { result: Promise<unknown>; settled: boolean }>()
  private readonly requests = new Set<Promise<unknown>>()
  private readonly settlements = new Set<Promise<void>>()
  private readonly peers = new Set<SshRpcPeer>()
  private readonly sockets = new Set<Socket>()
  private shutdown: Promise<void> | undefined
  private readonly lifetime = new AbortController()
  private server: Server | undefined
  private readonly fibers: Fiber[] = []

  /** @param config - installation paths, Host public key and resource bounds. */
  constructor(private readonly config: RuntimeConfig) {
    this.authorizedKey = runtimePublicKey(config.authorizedKey)
  }

  /**
   * Start the daemon and atomically advertise its loopback endpoint after services are ready.
   * @returns the loopback TCP port allocated by the operating system.
   */
  async start(): Promise<number> {
    this.fibers.push(await this.ctx.plugin(SessionProjectionRegistry))
    this.fibers.push(await this.ctx.plugin(SandboxPolicyService, { mode: 'read-only', workspaceRoot: homedir() }))
    this.fibers.push(await this.ctx.plugin(SandboxedFileSystem, { cwd: homedir() }))
    this.fibers.push(await this.ctx.plugin(LocalSandboxProvider))
    this.fibers.push(await this.ctx.plugin(LocalSubprocessRuntime))
    const server = createServer((socket) => {
      this.sockets.add(socket)
      socket.once('close', () => {
        this.sockets.delete(socket)
      })
      socket.on('error', () => {
        socket.destroy()
      })
      const admission = (async () => {
        try {
          await authenticateRuntimeServer(
            socket,
            this.authorizedKey,
            this.identity,
            AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.config.authenticationTimeoutMs)]),
          )
        } catch (_unauthenticatedClient) {
          // An unauthenticated client owns no Runtime work or large RPC buffers.
          socket.destroy()
          return
        }
        this.lifetime.signal.throwIfAborted()
        let authenticated = false
        const handle = async (method: string, raw: unknown, signal: AbortSignal): Promise<unknown> => {
          this.lifetime.signal.throwIfAborted()
          if (!authenticated) {
            if (method !== 'hello') throw new Error('Remote runtime authentication required')
            const input = z
              .object({ version: z.string(), protocol: z.literal(1) })
              .strict()
              .parse(raw)
            if (input.version !== this.config.version) throw new Error('Remote runtime version mismatch')
            authenticated = true
            return {
              instance: this.instance,
              platform: process.platform,
              home: homedir(),
              executable: process.execPath,
              version: this.config.version,
            }
          }
          if (method === 'recover') {
            const { id } = idInput.parse(raw)
            const record = this.operations.get(id)
            if (record === undefined) return { kind: 'unknown' }
            return { kind: 'completed', value: await record.result }
          }
          if (method === 'forget') {
            this.operations.delete(idInput.parse(raw).id)
            return null
          }
          if (method === 'execute') {
            const input = invocation.parse(raw)
            const known = this.operations.get(input.id)
            if (known !== undefined) return known.result
            if (this.operations.size >= this.config.maxRememberedOperations) {
              const expired = [...this.operations].find(([, record]) => record.settled)?.[0]
              if (expired !== undefined) this.operations.delete(expired)
            }
            if (this.operations.size >= this.config.maxRememberedOperations)
              throw new Error('Too many remote operations are still active; wait for them to settle')
            const record = { result: this.dispatch(input.method, input.params, signal), settled: false }
            this.operations.set(input.id, record)
            void record.result
              .finally(() => {
                record.settled = true
              })
              .catch(() => {})
            return record.result
          }
          if (method === 'observe') {
            const input = z.object({ method: z.string(), params: z.unknown() }).strict().parse(raw)
            const observation =
              /^(?:fs\.(?:resolve|stat|lstat|list|readText|readBytes|readRange)|process\.(?:read|wait))$/u.test(input.method)
              || /^(?:terminal\.(?:environment|inspect|activity)|executable|sandbox|directory\.list)$/u.test(input.method)
            if (!observation) {
              throw new Error('Remote observation cannot mutate state')
            }
            return this.dispatch(input.method, input.params, signal)
          }
          throw new Error(`Unknown runtime request: ${method}`)
        }
        const peer = new SshRpcPeer(
          socket,
          socket,
          this.config.maxFrameBytes,
          128,
          async (method, raw, requestSignal) => {
            const request = handle(method, raw, AbortSignal.any([requestSignal, this.lifetime.signal]))
            this.requests.add(request)
            try {
              const value = await request
              if (Buffer.byteLength(JSON.stringify(value ?? null)) + 1024 > this.config.maxFrameBytes) {
                throw new RemoteOperationError(
                  'Remote result exceeds the transport budget; request a smaller file range',
                  'REMOTE_RESULT_TOO_LARGE',
                )
              }
              return value
            } finally {
              this.requests.delete(request)
            }
          },
        )
        this.peers.add(peer)
        peer.once('closed', () => {
          this.peers.delete(peer)
          socket.destroy()
        })
      })()
      this.requests.add(admission)
      void admission
        .catch((error: unknown) => {
          socket.destroy()
          this.ctx.logger.warn('Runtime connection setup failed', error)
        })
        .finally(() => {
          this.requests.delete(admission)
        })
    })
    server.maxConnections = this.config.maxConnections
    this.server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Runtime did not allocate a TCP endpoint')
    await mkdir(this.config.root, { recursive: true, mode: 0o700 })
    const temporary = join(this.config.root, `${randomUUID()}.endpoint`)
    await writeFile(
      temporary,
      JSON.stringify({ port: address.port, pid: process.pid, instance: this.instance, publicKey: this.publicKey }),
      { mode: 0o600, flag: 'wx' },
    )
    await rename(temporary, join(this.config.root, 'endpoint.json'))
    return address.port
  }

  /** Stop all owned work only for explicit daemon shutdown, never for client transport loss. */
  close(): Promise<void> {
    return (this.shutdown ??= this.closeOnce())
  }

  private async closeOnce(): Promise<void> {
    this.lifetime.abort(new Error('Remote runtime stopped'))
    for (const peer of this.peers) peer.close()
    for (const socket of this.sockets) socket.destroy()
    await new Promise<void>((resolve, reject) => {
      if (this.server === undefined) resolve()
      else
        this.server.close((error) => {
          if (error === undefined) resolve()
          else reject(error)
        })
    })
    await Promise.allSettled(this.requests)
    for (const fiber of this.fibers.reverse()) await fiber.dispose()
    await Promise.allSettled(this.settlements)
  }

  private async dispatch(method: string, raw: unknown, signal: AbortSignal): Promise<unknown> {
    if (method.startsWith('fs.')) return runtimeFileOperation(this.ctx, method, raw, signal)
    if (method === 'directory.list') {
      const { path } = z.object({ path: z.string().optional() }).strict().parse(raw)
      const target = await this.ctx.fs.resolve(path ?? homedir(), { signal })
      const entries = await this.ctx.fs.listDir(target, signal)
      return {
        path: this.ctx.fs.processPath(target),
        entries: entries
          .filter(entry => entry.type === 'directory')
          .map(entry => ({ name: entry.name, path: this.ctx.fs.processPath(entry.target) })),
      }
    }
    if (method === 'executable') {
      const input = z
        .object({ command: z.string(), env: z.record(z.string(), z.string()).optional() })
        .strict()
        .parse(raw)
      return this.ctx.subprocess.resolveExecutable(input.command, input.env, signal)
    }
    if (method === 'terminal.environment') return this.ctx.subprocess.terminalEnvironment(signal)
    if (method === 'sandbox') {
      const input = z
        .object({ argv: z.array(z.string()).min(1), policy: policySchema })
        .strict()
        .parse(raw)
      if (input.policy.mode === 'danger-full-access')
        throw new Error('Unconfined commands do not need a sandbox wrapper')
      const policy: SandboxPolicy = {
        mode: input.policy.mode,
        workspaceRoot: input.policy.workspaceRoot,
        ...(input.policy.additionalWritableRoots === undefined
          ? {}
          : { additionalWritableRoots: input.policy.additionalWritableRoots }),
        ...(input.policy.sessionId === undefined ? {} : { sessionId: SessionId(input.policy.sessionId) }),
      }
      return this.ctx.sandbox.confine(input.argv, policy, signal)
    }
    if (method === 'process.start') return this.startProcess(raw)
    if (method === 'process.wait') {
      const record = this.process(idInput.parse(raw).id)
      if (record.terminal) throw new Error('Managed-range waiting requires an ordinary process')
      return (record.handle as SubprocessHandle).waitForExit(signal)
    }
    if (method === 'process.read') {
      const input = z
        .object({ id: z.uuid(), offsets: z.record(z.string(), z.number().int().nonnegative()) })
        .strict()
        .parse(raw)
      const record = this.process(input.id)
      let complete = true
      const output = Object.fromEntries(
        Object.entries(record.output).map(([name, collector]) => {
          const snapshot = collector.snapshot()
          const start = snapshot.totalBytes - snapshot.bytes.length
          const requested = input.offsets[name] ?? 0
          const offset = Math.max(start, requested)
          const data = snapshot.bytes.subarray(offset - start, offset - start + this.config.readChunkBytes)
          const nextOffset = offset + data.length
          if (nextOffset < snapshot.totalBytes) complete = false
          return [name, { data: data.toString('base64'), nextOffset, lossy: requested < start }]
        }),
      )
      return { output, complete, outcome: record.outcome ?? null, error: record.error ?? null }
    }
    const { id, ...args } = z
      .object({
        id: z.uuid(),
        value: z.string().optional(),
        cols: z.number().int().positive().optional(),
        rows: z.number().int().positive().optional(),
      })
      .strict()
      .parse(raw)
    const record = this.process(id)
    if (method === 'process.stop') {
      if (record.terminal) await (record.handle as SubprocessTerminalHandle).terminate()
      else {
        const handle = record.handle as SubprocessHandle
        handle.terminate()
        await handle.waitForExit()
      }
      record.quiescent = true
      return null
    }
    if (method === 'process.input' || method === 'process.control') {
      const handle = record.handle as SubprocessHandle
      const stream = method === 'process.control' ? handle.control : handle.stdin
      if (stream === undefined) throw new Error('Process input is not writable')
      await new Promise<void>((resolve, reject) => {
        stream.write(z.string().parse(args.value), (error) => {
          if (error === null || error === undefined) resolve()
          else reject(error)
        })
      })
      return null
    }
    if (!record.terminal) throw new Error('Operation requires a terminal')
    const terminal = record.handle as SubprocessTerminalHandle
    switch (method) {
      case 'terminal.write':
        await terminal.write(z.string().parse(args.value))
        return null
      case 'terminal.resize':
        await terminal.resize(z.number().parse(args.cols), z.number().parse(args.rows))
        return null
      case 'terminal.inspect':
        return (await terminal.inspectForeground()) ?? null
      case 'terminal.activity':
        return terminal.inspectActivity()
      case 'terminal.signal':
        return terminal.signalForeground(z.enum(['SIGINT', 'SIGTERM', 'SIGKILL']).parse(args.value))
      default:
        throw new Error(`Unknown process operation: ${method}`)
    }
  }

  private async startProcess(raw: unknown): Promise<{ id: string; pid: number | null }> {
    const { id, spec } = z.object({ id: z.uuid(), spec: spawnSchema }).strict().parse(raw)
    const known = this.processes.get(id)
    if (known !== undefined) return { id, pid: known.terminal ? (known.handle as SubprocessTerminalHandle).pid : null }
    if (this.processes.size >= this.config.maxProcesses) {
      const expired = [...this.processes.values()].find(record => record.quiescent)
      if (expired !== undefined) this.processes.delete(expired.id)
    }
    if (this.processes.size >= this.config.maxProcesses)
      throw new Error('Remote active task limit reached; stop a retained running task before starting more')
    const env =
      spec.env === undefined
        ? undefined
        : Object.fromEntries(Object.entries(spec.env).map(([name, value]) => [name, value ?? undefined]))
    const output = Object.fromEntries(
      ['stdout', 'stderr', 'control', 'terminal'].map(name => [
        name,
        new OutputCollector(this.config.maxOutputBytes, name, undefined),
      ]),
    ) as ProcessRecord['output']
    const terminalSpec = spec.terminal
    const argv =
      spec.argv[0] === '@dsh/ripgrep'
        ? [
          join(
            this.config.root,
            `node_modules/@vscode/ripgrep-${process.platform}-${process.arch}/bin/rg${process.platform === 'win32' ? '.exe' : ''}`,
          ),
          ...spec.argv.slice(1),
        ]
        : spec.argv
    let handle: SubprocessHandle | SubprocessTerminalHandle
    if (terminalSpec === undefined) {
      const stdio = spec.stdio
      if (stdio === undefined) throw new Error('An ordinary process requires stdio configuration')
      handle = this.ctx.subprocess.spawn({
        argv,
        cwd: spec.cwd,
        graceMs: spec.graceMs,
        ...(env === undefined ? {} : { env }),
        stdio: {
          stdin: stdio.stdin,
          stdout: 'pipe',
          stderr: 'pipe',
          ...(stdio.control === undefined ? {} : { control: stdio.control }),
        },
      })
    } else {
      handle = await this.ctx.subprocess.spawnTerminal({
        argv,
        cwd: spec.cwd,
        graceMs: spec.graceMs,
        ...(env === undefined ? {} : { env }),
        ...terminalSpec,
      } as SubprocessTerminalSpawnSpec)
    }
    const record: ProcessRecord = { id, handle, terminal: terminalSpec !== undefined, output, quiescent: false }
    this.processes.set(id, record)
    if (record.terminal) {
      ;(handle as SubprocessTerminalHandle).output.on('data', (chunk) => {
        output.terminal.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
      })
    } else {
      const process = handle as SubprocessHandle
      for (const name of ['stdout', 'stderr', 'control'] as const) {
        process[name]?.on('data', (chunk) => {
          output[name].push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
        })
      }
    }
    const settled = handle.done
      .then(
        (outcome) => {
          record.outcome = outcome
        },
        (error: unknown) => {
          record.error = error instanceof Error ? error.message : String(error)
        },
      )
      .then(async () => {
        record.quiescent = record.terminal
          ? (await (handle as SubprocessTerminalHandle).inspectActivity()).state === 'idle'
          : await (handle as SubprocessHandle).waitForExit()
      })
      .catch((error: unknown) => {
        this.ctx.logger.warn('Remote process quiescence could not be confirmed', error)
      })
    this.settlements.add(settled)
    void settled.finally(() => {
      this.settlements.delete(settled)
    })
    return { id, pid: record.terminal ? (handle as SubprocessTerminalHandle).pid : null }
  }

  private process(id: string): ProcessRecord {
    const record = this.processes.get(id)
    if (record === undefined)
      throw new Error(
        'Remote task output is unavailable: completed output expired or the Runtime restarted. Do not restart the command automatically.',
      )
    return record
  }
}
