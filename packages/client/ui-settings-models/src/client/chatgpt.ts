/** ChatGPT connection interaction and subscription-only profile activation. */

import type { Context } from '@deepseek-ai/cordis'
import type { AuthorizationFrame, AuthorizationReply, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { ModelsSettingsStore } from './store.ts'

/** Transient state retained while the Models page is closed or remounted. */
export interface ChatGptState {
  status: 'idle' | 'signing-in' | 'saving' | 'disconnecting'
  notice: Extract<AuthorizationFrame, { type: 'notice' }>['notice'] | null
  prompt: Extract<AuthorizationFrame, { type: 'prompt' }> | null
  failure: 'signIn' | 'models' | 'settings' | 'disconnect' | null
}

/** The actions exposed to the subscription card; no credential values enter its state. */
export interface ChatGptActions {
  /** Start browser authorization, or finish setup using an already stored grant. */
  readonly connect: (namespace: SettingsNamespaceView, reuseGrant: boolean) => void
  /** Reply to the current question on its originating stream. */
  readonly answer: (reply: AuthorizationReply) => void
  /** Withdraw the running browser authorization or model-list request. */
  readonly cancel: () => void
  /** Remove the OAuth grant without changing the subscription-only authentication policy. */
  readonly disconnect: () => void
}

/** One client plugin instance owns and disposes the active authorization stream. */
export class ChatGptConnection {
  /** Transient UI interaction; contains no OAuth credential values. */
  readonly store = createSnapshotStore<ChatGptState>({ status: 'idle', notice: null, prompt: null, failure: null })
  private attempt: AbortController | undefined
  private work: Promise<void> | undefined
  private stream: ReturnType<Context['remote']['authorization']['signIn']> | undefined

  /** Caller-bound commands for the subscription card. */
  readonly actions: ChatGptActions = {
    connect: (namespace, reuseGrant) => {
      if (this.work !== undefined) return
      this.start(controller => this.connect(namespace, reuseGrant, controller.signal))
    },
    answer: (reply) => { this.stream?.send(reply) },
    cancel: () => { this.attempt?.abort(); this.stream?.dispose() },
    disconnect: () => {
      if (this.work !== undefined) return
      this.start(async () => {
        this.store.update((s) => { s.status = 'disconnecting'; s.failure = null })
        const response = await this.ctx.remote.authorization.signOut('llm-pi-ai', 'openai')
        if (!response.ok) this.store.update((s) => { s.failure = 'disconnect' })
      })
    },
  }

  /** @param ctx - plugin context declaring authorization, settings, and LLM Remote dependencies.
   * @param models - Models page controller refreshed after each committed change.
   */
  constructor(private readonly ctx: Context, private readonly models: Pick<ModelsSettingsStore, 'load'>) {}

  /** Cancel owned interaction and await the client consumer's completion. */
  async dispose(): Promise<void> {
    this.actions.cancel()
    await this.work
  }

  private start(run: (controller: AbortController) => Promise<void>): void {
    const controller = new AbortController()
    this.attempt = controller
    this.work = run(controller).then(() => this.models.load()).catch(() => {
      if (!controller.signal.aborted) this.store.update((s) => {
        s.failure ??= s.status === 'disconnecting' ? 'disconnect' : s.status === 'saving' ? 'settings' : 'signIn'
      })
    }).finally(() => {
      this.stream?.dispose()
      this.stream = undefined
      this.attempt = undefined
      this.work = undefined
      this.store.update((s) => { s.status = 'idle'; s.prompt = null; s.notice = null })
    })
  }

  private async connect(namespace: SettingsNamespaceView, reuseGrant: boolean, signal: AbortSignal): Promise<void> {
    this.store.update((s) => { s.status = 'signing-in'; s.failure = null; s.notice = null; s.prompt = null })
    if (!reuseGrant) {
      const stream = this.ctx.remote.authorization.signIn('llm-pi-ai', 'openai', 'oauth', signal)
      this.stream = stream
      let authorized = false
      for await (const frame of stream) {
        switch (frame.type) {
          case 'notice': this.store.update((s) => { s.notice = frame.notice }); break
          case 'prompt': this.store.update((s) => { s.prompt = frame }); break
          case 'withdraw': this.store.update((s) => { if (s.prompt?.id === frame.id) s.prompt = null }); break
          case 'failed': this.store.update((s) => { s.failure = 'signIn' }); return
          case 'settled': authorized = frame.outcome.status === 'authorized'; break
          /* v8 ignore next -- the generated Remote frame type is closed and the Host only produces its declared variants. */
          default: assertNever(frame)
        }
      }
      if (!authorized || signal.aborted) return
    }
    this.store.update((s) => { s.status = 'saving'; s.prompt = null; s.notice = null })
    const discovered = await this.ctx.remote.llm.discoverModels('llm-pi-ai', { provider: 'openai' }, signal)
    if (signal.aborted) return
    if (!discovered.ok || discovered.value.length === 0) {
      this.store.update((s) => { s.failure = 'models' })
      return
    }
    const path = ['providers', 'openai']
    const saved = await this.ctx.remote.settings.mutate(namespace.ns, [
      { op: 'set', path: [...path, 'auth'], value: 'chatgpt' },
      { op: 'set', path: [...path, 'models'], value: discovered.value.map(model => ({
        id: model.id, ...model.name === undefined ? {} : { name: model.name },
        ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
        ...model.inputModalities === undefined ? {} : { input: [...model.inputModalities] },
      })) },
      ...['apiKeyEnv', 'api', 'baseURL', 'modelOverrides'].map(field => ({ op: 'unset' as const, path: [...path, field] })),
    ], namespace.revision)
    if (!saved.ok) this.store.update((s) => { s.failure = 'settings' })
  }
}
