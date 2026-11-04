/** React-free mirror of saved computers and their supervised SSH connections. */
import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-api-remote-access/client'
import type {} from '@deepseek-ai/dsh-remote-work/remote'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {
  ComputerId,
  ComputerState,
  ConnectComputerRequest,
  ConnectComputerResult,
} from '@deepseek-ai/dsh-remote-work/types'

export type {
  ComputerId,
  ComputerState,
  RemoteComputer,
  ConnectComputerRequest,
  ConnectComputerResult,
} from '@deepseek-ai/dsh-remote-work/types'

/** One full Host-authoritative computer projection. */
export interface ComputerSnapshot {
  readonly items: readonly ComputerState[]
  readonly phase: 'loading' | 'ready' | 'error'
  readonly error?: string
}
/** Client computer commands and stable observable state. */
export interface RemoteComputers {
  readonly source: {
    /** Return the current complete computer snapshot.
     * @returns stable observable value until the next update.
     */
    getSnapshot(): ComputerSnapshot
    /** Observe snapshot replacement.
     * @param listener - update notification.
     * @returns unsubscribe callback.
     */
    subscribe(listener: () => void): () => void
  }
  /** Verify or connect an SSH computer; passwords remain request-local.
   * @param request - endpoint, account, and optional confirmed fingerprint.
   * @param signal - request cancellation.
   * @returns fingerprint confirmation or the connected computer.
   */
  connect(request: ConnectComputerRequest, signal: AbortSignal): Promise<ConnectComputerResult>
  /** Suspend a computer attachment without stopping remote tasks.
   * @param id - saved computer identity.
   */
  disconnect(id: ComputerId): Promise<void>
  /** List remote child directories.
   * @param id - saved computer.
   * @param path - native directory, or home when absent.
   * @param signal - cancellation.
   * @returns resolved path and child folders.
   */
  browse(
    id: ComputerId,
    path: string | undefined,
    signal: AbortSignal,
  ): Promise<{ path: string; entries: { name: string; path: string }[] }>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    remoteComputers: RemoteComputers
  }
}

class ClientRemoteComputers extends Service implements RemoteComputers {
  readonly source = createSnapshotStore<ComputerSnapshot>({ items: [], phase: 'ready' })
  private readonly closures = new Set<() => Promise<void>>()
  private stopping = false

  constructor(ctx: Context) {
    super(ctx, 'remoteComputers')
    ctx.effect(() => async () => {
      this.stopping = true
      this.source.set({ items: [], phase: 'ready' })
      const results = await Promise.allSettled([...this.closures].map(close => close()))
      const failures: unknown[] = []
      for (const result of results) {
        if (result.status === 'rejected') {
          const failure: unknown = result.reason
          failures.push(failure)
        }
      }
      if (failures.length > 0) throw new AggregateError(failures, 'Remote computer stream cleanup failed')
    })
    ctx.remoteAccess.whenAccess('remoteWork/follow', () => {
      if (this.stopping) return () => {}
      const stream = ctx.remote.$stream<ComputerState[]>({
        name: 'Remote computer state',
        open: signal => ctx.remote.remoteWork.follow(signal),
        ended: () => new Error('Remote computer state stream ended'),
      })
      const attachment = { disposed: false }
      let closing: Promise<void> | undefined
      const consume = (async () => {
        for await (const frame of stream) {
          if (attachment.disposed) break
          this.source.set({ items: frame.value, phase: 'ready' })
          frame.accept()
        }
      })().catch((error: unknown) => {
        if (!attachment.disposed) {
          this.source.set({
            items: this.source.getSnapshot().items,
            phase: 'error',
            error: error instanceof Error ? error.message : String(error),
          })
        }
      })
      const close = (): Promise<void> => {
        attachment.disposed = true
        closing ??= (async () => {
          await stream.dispose()
          await consume
        })().finally(() => {
          this.closures.delete(close)
        })
        return closing
      }
      this.closures.add(close)
      return () => {
        attachment.disposed = true
        this.source.set({ items: [], phase: 'ready' })
        void close().catch((error: unknown) => {
          ctx.logger.error('Remote computer stream cleanup failed', error)
        })
      }
    })
  }

  async connect(request: ConnectComputerRequest, signal: AbortSignal): Promise<ConnectComputerResult> {
    const result = await this.ctx.remote.remoteWork.connectComputer(request, signal)
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }
  async disconnect(id: ComputerId): Promise<void> {
    const result = await this.ctx.remote.remoteWork.disconnectComputer(id)
    if (!result.ok) throw new Error(result.error.message)
  }
  async browse(
    id: ComputerId,
    path: string | undefined,
    signal: AbortSignal,
  ): Promise<{ path: string; entries: { name: string; path: string }[] }> {
    const result = await this.ctx.remote.remoteWork.browse(id, path, signal)
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }
}

/** Required generated Remote namespace. */
export const inject = ['remote', 'remote.remoteWork', 'remoteAccess']
/** Install the computer model for all workspace surfaces.
 * @param ctx - Client application context.
 */
export function apply(ctx: Context): void {
  new ClientRemoteComputers(ctx)
}
