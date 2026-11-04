/** Reconnect supervisor with observation retries and recovery-only handling of ambiguous mutations. */
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { SshRpcPeer, RemoteOperationError } from '@deepseek-ai/dsh-ssh/protocol'
import { z } from 'zod'
import { SshSession, HostIdentityRequired } from './ssh-session.ts'
import { authenticateRuntimeClient, RemoteRuntimeIdentityError } from './authentication.ts'
import { installRuntime, probePlatform, type InstallConfig, type RemotePlatform } from './install.ts'
import type { ComputerState, ConnectComputerRequest } from './types.ts'
import { cancellationError } from './cancellation.ts'

const helloSchema = z
  .object({
    instance: z.uuid(),
    platform: z.enum(['linux', 'win32']),
    home: z.string(),
    executable: z.string(),
    version: z.string(),
  })
  .strict()
type Hello = z.infer<typeof helloSchema>

/** The remote may have committed an effect, but its daemon cannot recover a result. */
export class RemoteOutcomeUnknown extends Error {
  /** Stable uncertainty classification; it does not imply rollback. */
  readonly code = 'REMOTE_OUTCOME_UNKNOWN'
  /** @param method - operation that must not be replayed automatically. */
  constructor(method: string) {
    super(
      `The connection was interrupted during ${method}. Its result cannot be recovered. Inspect the remote state before retrying.`,
    )
    this.name = 'RemoteOutcomeUnknown'
  }
}

/** One computer's independent connection and remote daemon generation. */
export class RemoteConnection {
  private ssh: SshSession | undefined
  private peer: SshRpcPeer | undefined
  private connecting: Promise<Hello> | undefined
  private hello: Hello | undefined
  private suspension: PromiseWithResolvers<void> | undefined
  private readonly lifetime = new AbortController()
  private readonly operations = new Set<Promise<unknown>>()
  /** Latest verified native platform. */
  platform: RemotePlatform | undefined

  /**
   * @param identity - saved computer identity and memory-only credentials.
   * @param privateKey - saved Host signing key; never uploaded or exposed to the Client.
   * @param install - local artifacts and remote resource limits.
   * @param timeoutMs - SSH and finite installation deadline.
   * @param reconnectDelayMs - supervision backoff after transport loss.
   * @param changed - owner callback for visible connection state.
   */
  constructor(
    private identity: ConnectComputerRequest & { id: NonNullable<ConnectComputerRequest['id']> },
    private readonly privateKey: string,
    private readonly install: InstallConfig,
    private readonly timeoutMs: number,
    private readonly reconnectDelayMs: number,
    private readonly changed: (status: ComputerState['status'], error?: string) => void,
  ) {}

  /** Whether this local attachment has been explicitly closed. */
  get closed(): boolean {
    return this.lifetime.signal.aborted
  }

  /**
   * Replace verified authentication while preserving pending task observations.
   * @param identity - same computer and SSH endpoint with newly verified credentials or fingerprint.
   * @throws when the attachment is closed or the endpoint would change.
   */
  reconfigure(identity: ConnectComputerRequest & { id: NonNullable<ConnectComputerRequest['id']> }): void {
    this.lifetime.signal.throwIfAborted()
    if (
      identity.id !== this.identity.id ||
      identity.host !== this.identity.host ||
      identity.port !== this.identity.port ||
      identity.username !== this.identity.username
    ) {
      throw new Error('A reconnect cannot change the execution computer or SSH account')
    }
    const previous = this.ssh
    this.identity = identity
    this.resume()
    this.peer?.close()
    if (previous !== undefined) {
      const closing = previous.close()
      this.operations.add(closing)
      void closing
        .finally(() => {
          this.operations.delete(closing)
        })
        .catch(() => {})
    }
  }

  /** Connect once; initial configuration and authentication failures are visible to the initiating caller.
   * @returns verified daemon facts.
   */
  connect(): Promise<Hello> {
    this.resume()
    return this.ensure(false)
  }

  /** Pause the SSH attachment without retiring handles or sending remote stops. */
  async suspend(): Promise<void> {
    this.lifetime.signal.throwIfAborted()
    const suspension = (this.suspension ??= Promise.withResolvers<void>())
    const previous = this.ssh
    this.peer?.close()
    await previous?.close()
    if (this.suspension === suspension) this.changed('disconnected')
  }

  private resume(): void {
    const suspended = this.suspension
    this.suspension = undefined
    suspended?.resolve()
  }

  /**
   * Perform one RPC, awaiting reconnection without resending uncertain mutations.
   * @param method - private runtime operation.
   * @param params - JSON arguments.
   * @param schema - response validation.
   * @param signal - caller cancellation; committed effects are not rolled back.
   * @param observation - true only for explicitly non-mutating operations.
   * @returns validated current or recovered result.
   */
  request<T>(
    method: string,
    params: unknown,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
    observation: boolean = false,
  ): Promise<T> {
    const operation = this.perform(method, params, schema, signal, observation)
    this.operations.add(operation)
    void operation
      .finally(() => {
        this.operations.delete(operation)
      })
      .catch(() => {})
    return operation
  }

  private async perform<T>(
    method: string,
    params: unknown,
    schema: z.ZodType<T>,
    signal: AbortSignal | undefined,
    observation: boolean,
  ): Promise<T> {
    const control = signal === undefined ? this.lifetime.signal : AbortSignal.any([signal, this.lifetime.signal])
    control.throwIfAborted()
    const hello = await this.ensure(true, control)
    const id = randomUUID()
    const peer = this.peer as SshRpcPeer
    try {
      const result = await peer.request(
        observation ? 'observe' : 'execute',
        observation ? { method, params } : { id, method, params },
        schema,
        control,
      )
      if (!observation) void peer.request('forget', { id }, z.null(), this.lifetime.signal).catch(() => {})
      return result
    } catch (error) {
      control.throwIfAborted()
      if (error instanceof RemoteOperationError) {
        if (!observation) {
          void peer.request('forget', { id }, z.null(), this.lifetime.signal).catch(() => {})
          if (error.code === 'REMOTE_RESULT_TOO_LARGE') throw new RemoteOutcomeUnknown(method)
        }
        throw error
      }
      if (this.peer === peer) throw error
      if (observation) return this.perform(method, params, schema, control, true)
      return this.recover(hello.instance, method, id, schema, control)
    }
  }

  private async recover<T>(
    instance: string,
    method: string,
    id: string,
    schema: z.ZodType<T>,
    signal: AbortSignal,
  ): Promise<T> {
    while (true) {
      const current = await this.ensure(true, signal)
      if (current.instance !== instance) throw new RemoteOutcomeUnknown(method)
      const peer = this.peer as SshRpcPeer
      let received = false
      try {
        const recovery = await peer.request(
          'recover',
          { id },
          z.discriminatedUnion('kind', [
            z.object({ kind: z.literal('unknown') }).strict(),
            z.object({ kind: z.literal('completed'), value: schema }).strict(),
          ]),
          signal,
        )
        received = true
        if (recovery.kind === 'unknown') throw new RemoteOutcomeUnknown(method)
        return recovery.value
      } catch (error) {
        signal.throwIfAborted()
        if (error instanceof RemoteOperationError || error instanceof z.ZodError) {
          received = true
          if (error instanceof z.ZodError || error.code === 'REMOTE_RESULT_TOO_LARGE')
            throw new RemoteOutcomeUnknown(method)
          throw error
        }
        if (this.peer === peer) throw error
      } finally {
        if (received) void peer.request('forget', { id }, z.null(), this.lifetime.signal).catch(() => {})
      }
    }
  }

  private ensure(retry: boolean, signal?: AbortSignal): Promise<Hello> {
    this.lifetime.signal.throwIfAborted()
    signal?.throwIfAborted()
    if (this.peer !== undefined && this.hello !== undefined) return Promise.resolve(this.hello)
    this.connecting ??= this.open(retry).finally(() => {
      this.connecting = undefined
    })
    if (signal === undefined) return this.connecting
    return new Promise<Hello>((resolve, reject) => {
      const abort = (): void => {
        reject(cancellationError(signal))
      }
      signal.addEventListener('abort', abort, { once: true })
      void (this.connecting as Promise<Hello>).then(resolve, reject).finally(() => {
        signal.removeEventListener('abort', abort)
      })
      if (signal.aborted) abort()
    })
  }

  private async open(retry: boolean): Promise<Hello> {
    while (true) {
      this.lifetime.signal.throwIfAborted()
      const suspended = this.suspension
      if (suspended !== undefined) {
        await suspended.promise
        continue
      }
      this.lifetime.signal.throwIfAborted()
      this.changed(this.hello === undefined ? 'connecting' : 'reconnecting')
      const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.timeoutMs)])
      const identity = this.identity
      const ssh = new SshSession(identity, this.timeoutMs, this.install.keepaliveIntervalMs, this.install.keepaliveMax)
      this.ssh = ssh
      try {
        await ssh.connect(signal)
        const platform = await probePlatform(ssh, signal)
        this.platform = platform
        this.changed('installing')
        const installation = await installRuntime(
          ssh,
          platform,
          this.identity.id,
          this.privateKey,
          this.install,
          signal,
        )
        const channel = await ssh.forward(installation.port)
        await authenticateRuntimeClient(
          channel,
          this.privateKey,
          installation.publicKey,
          AbortSignal.any([signal, AbortSignal.timeout(this.install.authenticationTimeoutMs)]),
        )
        const peer = new SshRpcPeer(channel, channel, this.install.maxFrameBytes, 128)
        const closed = (): void => {
          if (this.peer !== peer) return
          this.peer = undefined
          if (this.lifetime.signal.aborted || this.suspension !== undefined) return
          this.changed('reconnecting', 'Remote connection lost; task status will be checked after reconnection')
          void this.ensure(true).catch((error: unknown) => {
            if (!this.lifetime.signal.aborted) this.changed('error', String(error))
          })
        }
        peer.once('closed', closed)
        const hello = await peer.request('hello', { protocol: 1, version: installation.version }, helloSchema, signal)
        if (this.suspension !== undefined || identity !== this.identity) {
          peer.close()
          await ssh.close()
          continue
        }
        this.peer = peer
        this.hello = hello
        void ssh.ended.then(() => {
          peer.close()
        })
        this.changed('connected')
        return hello
      } catch (error) {
        await ssh.close()
        this.lifetime.signal.throwIfAborted()
        if (identity !== this.identity || this.suspension !== undefined) continue
        this.changed(retry ? 'reconnecting' : 'error', error instanceof Error ? error.message : String(error))
        if (!retry || error instanceof HostIdentityRequired || error instanceof RemoteRuntimeIdentityError) {
          this.changed('error', error instanceof Error ? error.message : String(error))
          throw error
        }
        await delay(this.reconnectDelayMs, undefined, { signal: this.lifetime.signal })
      }
    }
  }

  /** Close local attachments and supervision, leaving all remote tasks owned by the remote daemon. */
  async close(): Promise<void> {
    this.lifetime.abort(new Error('Remote attachment closed locally; no remote stop was sent'))
    this.resume()
    this.peer?.close()
    await this.ssh?.close()
    await this.connecting?.catch(() => {})
    await Promise.allSettled(this.operations)
    this.changed('disconnected')
  }
}
