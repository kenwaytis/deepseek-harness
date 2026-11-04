/** Reattachable process and terminal handles over offset-based remote observations. */
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { OutputCollector } from '@deepseek-ai/dsh-subprocess-local/output'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
  SubprocessTerminalEnvironment,
  SubprocessOutputRead,
} from '@deepseek-ai/dsh-subprocess'
import { z } from 'zod'
import { rgPath } from '@vscode/ripgrep'
import { foregroundSchema, terminalActivitySchema } from '@deepseek-ai/dsh-ssh/schemas'
import { remoteDirectoryOf } from '@deepseek-ai/dsh-util-workspace-path'
import type { ComputerId } from './types.ts'
import { RemoteOutcomeUnknown, type RemoteConnection } from './connection.ts'
import type {} from './index.ts'

const outputReadSchema = z
  .object({
    data: z.base64(),
    nextOffset: z.number().int().nonnegative(),
    lossy: z.boolean(),
    spillPath: z.string().optional(),
  })
  .strict()
const snapshotSchema = z
  .object({
    output: z
      .object({
        stdout: outputReadSchema,
        stderr: outputReadSchema,
        control: outputReadSchema,
        terminal: outputReadSchema,
      })
      .strict(),
    complete: z.boolean(),
    outcome: z.object({ exitCode: z.number().nullable(), signal: z.string().nullable() }).strict().nullable(),
    error: z.string().nullable(),
  })
  .strict()

function remoteEnvironment(env: NodeJS.ProcessEnv | undefined): Record<string, string | null> | undefined {
  return env === undefined
    ? undefined
    : Object.fromEntries(Object.entries(env).map(([name, value]) => [name, value ?? null]))
}

class RemoteProcessObservation {
  readonly id = randomUUID()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly terminal = new PassThrough()
  readonly control = new PassThrough()
  readonly completed = Promise.withResolvers<SubprocessOutcome>()
  private readonly output: Record<'stdout' | 'stderr', OutputCollector>
  private readonly bases = { stdout: 0, stderr: 0 }
  private readonly budgets: Record<'stdout' | 'stderr', number>
  private readonly offsets = { stdout: 0, stderr: 0, control: 0, terminal: 0 }
  private readonly abort = new AbortController()
  private readonly loop: Promise<void>
  readonly started: Promise<{ pid: number | null }>

  constructor(
    private readonly ctx: Context,
    private readonly connection: RemoteConnection,
    private readonly spec: SubprocessSpawnSpec | SubprocessTerminalSpawnSpec,
    readonly terminalMode: boolean,
  ) {
    const budget = (name: 'stdout' | 'stderr'): number => {
      if (!('stdio' in spec)) return ctx.remoteWork.outputBytes
      const mode = spec.stdio[name]
      return typeof mode === 'object' ? mode.maxBytes : ctx.remoteWork.outputBytes
    }
    this.budgets = { stdout: budget('stdout'), stderr: budget('stderr') }
    this.output = {
      stdout: new OutputCollector(this.budgets.stdout, 'stdout', undefined),
      stderr: new OutputCollector(this.budgets.stderr, 'stderr', undefined),
    }
    for (const stream of [this.stdout, this.stderr, this.terminal, this.control]) stream.on('error', () => {})
    const control = this.abort.signal
    this.started = connection.request(
      'process.start',
      {
        id: this.id,
        spec: {
          argv: spec.argv,
          cwd: spec.cwd,
          env: remoteEnvironment(spec.env),
          graceMs: spec.graceMs,
          ...('stdio' in spec
            ? { stdio: spec.stdio }
            : {
              terminal: {
                cols: spec.cols,
                rows: spec.rows,
                terminalType: spec.terminalType,
                shellActivity: spec.shellActivity,
              },
            }),
        },
      },
      z.object({ id: z.uuid(), pid: z.number().int().nonnegative().nullable() }).strict(),
      control,
    )
    this.loop = this.observe().catch((error: unknown) => {
      this.completed.reject(error)
      for (const stream of [this.stdout, this.stderr, this.terminal, this.control])
        stream.destroy(error instanceof Error ? error : new Error(String(error)))
    })
    void this.completed.promise.catch(() => {})
    const release = ctx.remoteWork.retainAttachment(() => this.detach())
    void this.loop.finally(release).catch(() => {})
  }

  read(name: 'stdout' | 'stderr', offset: number): SubprocessOutputRead {
    const read = this.output[name].readFrom(Math.max(0, offset - this.bases[name]))
    return { ...read, nextOffset: read.nextOffset + this.bases[name], lossy: read.lossy || offset < this.bases[name] }
  }

  async detach(): Promise<void> {
    this.abort.abort()
    await this.loop
  }

  async waitForExit(signal?: AbortSignal): Promise<boolean> {
    const control = signal === undefined ? this.abort.signal : AbortSignal.any([signal, this.abort.signal])
    const cancelled = (): boolean => control.aborted
    try {
      await this.started
      if (cancelled()) return false
      return await this.connection.request('process.wait', { id: this.id }, z.boolean(), control, true)
    } catch (error) {
      if (cancelled()) return false
      throw error
    }
  }

  async stop(): Promise<void> {
    await this.started
    const signal = AbortSignal.timeout(this.ctx.remoteWork.stopTimeoutMs)
    try {
      await this.connection.request('process.stop', { id: this.id }, z.null(), signal)
    } catch (error) {
      const failure = signal.aborted ? new RemoteOutcomeUnknown('stopping the remote task') : error
      this.abort.abort(failure)
      await this.loop
      throw failure
    }
  }

  input(method: string): Writable {
    return new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        void this.started
          .then(() => this.connection.request(method, { id: this.id, value: chunk.toString('utf8') }, z.null()))
          .then(
            () => {
              callback()
            },
            (error: unknown) => {
              callback(error instanceof Error ? error : new Error(String(error)))
            },
          )
      },
    })
  }

  private async observe(): Promise<void> {
    await this.started
    while (!this.abort.signal.aborted) {
      const snapshot = await this.connection.request(
        'process.read',
        { id: this.id, offsets: this.offsets },
        snapshotSchema,
        this.abort.signal,
        true,
      )
      for (const name of ['stdout', 'stderr', 'control', 'terminal'] as const) {
        const read = snapshot.output[name]
        const bytes = Buffer.from(read.data, 'base64')
        this.offsets[name] = read.nextOffset
        if (name === 'stdout' || name === 'stderr') {
          if (read.lossy) {
            this.output[name] = new OutputCollector(this.budgets[name], name, undefined)
            this.bases[name] = read.nextOffset - bytes.length
          }
          this.output[name].push(bytes)
        }
        if (
          read.lossy &&
          (name === 'control' ||
            (!this.terminalMode && 'stdio' in this.spec && this.spec.stdio[name as 'stdout' | 'stderr'] === 'pipe'))
        ) {
          throw new Error(
            'Remote pipe output exceeded retention while disconnected; the process remains on the remote computer',
          )
        }
        if (name === 'terminal' && read.lossy)
          this.terminal.write('\r\n[Remote output was truncated while disconnected]\r\n')
        const mode =
          !this.terminalMode && 'stdio' in this.spec && (name === 'stdout' || name === 'stderr')
            ? this.spec.stdio[name]
            : undefined
        const pipe =
          name === 'terminal'
            ? this.terminalMode
            : name === 'control'
              ? !this.terminalMode && 'stdio' in this.spec && this.spec.stdio.control === 'pipe'
              : mode === 'pipe'
        if (bytes.length > 0 && pipe && !this[name].write(bytes))
          await once(this[name], 'drain', { signal: this.abort.signal })
        if (bytes.length > 0 && mode === 'inherit') (name === 'stdout' ? process.stdout : process.stderr).write(bytes)
      }
      if (snapshot.error !== null) throw new Error(snapshot.error)
      if (snapshot.outcome !== null && snapshot.complete) {
        for (const stream of [this.stdout, this.stderr, this.terminal, this.control]) stream.end()
        this.completed.resolve({
          exitCode: snapshot.outcome.exitCode,
          signal: snapshot.outcome.signal as NodeJS.Signals | null,
        })
        return
      }
      if (snapshot.complete) await this.ctx.remoteWork.waitForPoll(this.abort.signal)
    }
  }
}

/** Computer-bound provider used only by a Session's execution consumers; local orchestration keeps its local provider. */
export class RemoteSubprocessRuntime extends SubprocessRuntime {
  static inject = ['remoteWork']
  private readonly lifetime = new AbortController()
  private readonly observations = new Set<RemoteProcessObservation>()

  /** @param ctx - isolated execution context. @param config - immutable computer identity. */
  constructor(
    ctx: Context,
    private readonly config: { computerId: ComputerId },
  ) {
    super(ctx)
    ctx.effect(
      () => async () => {
        this.lifetime.abort(new Error('Remote execution attachment disposed'))
        await Promise.allSettled([...this.observations].map(observation => observation.detach()))
      },
      'remote-work.process-attachments',
    )
  }

  private selected(): RemoteConnection {
    this.lifetime.signal.throwIfAborted()
    return this.ctx.remoteWork.connection(this.config.computerId)
  }

  private directory(cwd: string): string {
    const location = remoteDirectoryOf(cwd)
    if (location !== undefined && location.computerId !== this.config.computerId)
      throw new Error('A command cannot select another execution computer')
    return location?.path ?? cwd
  }

  private retain(observation: RemoteProcessObservation): void {
    this.observations.add(observation)
    void observation.completed.promise
      .finally(() => {
        this.observations.delete(observation)
      })
      .catch(() => {})
  }

  override resolveExecutable(
    command: string,
    env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string> {
    const remote = this.selected()
    return remote.request('executable', { command, env }, z.string(), signal, true)
  }

  override terminalEnvironment(signal?: AbortSignal): Promise<SubprocessTerminalEnvironment> {
    const remote = this.selected()
    return remote.request(
      'terminal.environment',
      {},
      z
        .object({ platform: z.enum(['posix', 'windows']), defaultShell: z.string().optional() })
        .strict()
        .transform(value => ({
          platform: value.platform,
          ...(value.defaultShell === undefined ? {} : { defaultShell: value.defaultShell }),
        })),
      signal,
      true,
    )
  }

  override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const remote = this.selected()
    if (spec.stdio.control === 'pipe')
      throw new Error('Remote work does not support PTC or custom fd 7 workers; use the standard Agent preset')
    spec.signal?.throwIfAborted()
    const observation = new RemoteProcessObservation(
      this.ctx,
      remote,
      {
        ...spec,
        cwd: this.directory(spec.cwd),
        argv: spec.argv[0] === rgPath ? ['@dsh/ripgrep', ...spec.argv.slice(1)] : spec.argv,
      },
      false,
    )
    this.retain(observation)
    const stdin = spec.stdio.stdin === 'pipe' ? observation.input('process.input') : undefined
    const stop = (): void => {
      void observation.stop().catch((error: unknown) => {
        this.ctx.logger.warn('Unable to stop remote task', error)
      })
    }
    spec.signal?.addEventListener('abort', stop, { once: true })
    void observation.completed.promise
      .finally(() => {
        spec.signal?.removeEventListener('abort', stop)
      })
      .catch(() => {})
    return {
      stdin,
      stdout: spec.stdio.stdout === 'pipe' ? observation.stdout : undefined,
      stderr: spec.stdio.stderr === 'pipe' ? observation.stderr : undefined,
      control: undefined,
      collected: {
        ...(typeof spec.stdio.stdout === 'object'
          ? { stdout: { readFrom: (offset: number) => observation.read('stdout', offset) } }
          : {}),
        ...(typeof spec.stdio.stderr === 'object'
          ? { stderr: { readFrom: (offset: number) => observation.read('stderr', offset) } }
          : {}),
      },
      done: observation.completed.promise,
      terminate: stop,
      waitForExit: async (signal) => {
        if (signal?.aborted === true) return false
        if (signal === undefined) return observation.waitForExit()
        return new Promise<boolean>((resolve, reject) => {
          const abort = (): void => {
            resolve(false)
          }
          signal.addEventListener('abort', abort, { once: true })
          void observation
            .waitForExit(signal)
            .then(resolve, reject)
            .finally(() => {
              signal.removeEventListener('abort', abort)
            })
          if (signal.aborted) abort()
        })
      },
    }
  }

  override async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    const remote = this.selected()
    spec.signal?.throwIfAborted()
    const observation = new RemoteProcessObservation(this.ctx, remote, { ...spec, cwd: this.directory(spec.cwd) }, true)
    this.retain(observation)
    const { pid } = await observation.started
    if (pid === null) throw new Error('Remote terminal has no process identity')
    return {
      pid,
      output: observation.terminal,
      done: observation.completed.promise,
      write: async (value) => {
        await remote.request('terminal.write', { id: observation.id, value }, z.null())
      },
      resize: async (cols, rows) => {
        await remote.request('terminal.resize', { id: observation.id, cols, rows }, z.null())
      },
      inspectForeground: async () =>
        (await remote.request('terminal.inspect', { id: observation.id }, foregroundSchema, undefined, true)) ??
        undefined,
      inspectActivity: () =>
        remote.request('terminal.activity', { id: observation.id }, terminalActivitySchema, undefined, true),
      signalForeground: value =>
        remote.request('terminal.signal', { id: observation.id, value }, z.number().int().positive()),
      terminate: () => observation.stop(),
    }
  }
}
