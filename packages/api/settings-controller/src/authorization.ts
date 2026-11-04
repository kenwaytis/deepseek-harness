/** Browser authorization over a caller-owned bidirectional Remote stream. */

import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { AuthorizationError } from '@deepseek-ai/dsh-authorization'
import type { AuthorizationService, AuthorizationPrompt } from '@deepseek-ai/dsh-authorization'
import { credentialKey, isCredentialKeySegment } from '@deepseek-ai/dsh-credentials'
import type { CredentialKey, CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteStream } from '@deepseek-ai/dsh-typert-protocol'
import type { AuthorizationFrame, AuthorizationPromptId, AuthorizationQuestion, AuthorizationReply, AuthorizationView } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Remote owner of registered credential-obtaining flows. */
    authorizationController: AuthorizationController
  }
}

/** Validate record addresses at both strict and source-launched Remote entry points. */
function keyFor(scope: string, id: string): CredentialKey {
  if (!isCredentialKeySegment(scope) || !isCredentialKeySegment(id)) {
    throw new RemoteError('gateway/bad-request', 'Invalid authorization record address.', {})
  }
  return credentialKey(scope, id)
}

/** Project only the fields of a question that may cross the wire. */
function question(prompt: AuthorizationPrompt): AuthorizationQuestion {
  if (prompt.kind === 'select') {
    return { kind: 'select', message: prompt.message, options: prompt.options.map(option => ({
      id: option.id, label: option.label,
      ...option.description === undefined ? {} : { description: option.description },
    })) }
  }
  return {
    kind: prompt.kind, message: prompt.message,
    ...prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder },
  }
}

/** Generic transport for authorization; protocol and grant formats remain flow-owned. */
export class AuthorizationController extends TypertRemoteService {
  /** @param ctx - Host context with optional authorization and credential services. */
  constructor(ctx: Context) { super(ctx, 'authorizationController', { namespace: 'authorization' }) }

  /**
   * Describe one registered flow without exposing its credential payload.
   * @param scope - credential owner's scope.
   * @param id - credential identity within that scope.
   * @returns method availability and redacted credential state, or null when no flow exists.
   */
  @Remote
  async describe(scope: string, id: string): Promise<AuthorizationView | null> {
    const key = keyFor(scope, id)
    const entry = this.ctx.get('authorization')?.describe(key)
    const credentials = this.ctx.get('credentials')
    if (entry === undefined || credentials === undefined) return null
    const stored = await credentials.describeRecord(key)
    return {
      methods: entry.methods.map(method => ({ id: method.id, label: method.label })),
      inFlight: entry.inFlight, kind: stored.kind ?? null, writable: stored.writable,
    }
  }

  /**
   * Obtain a credential through the caller's transient stream. Closing the
   * stream cancels the attempt and withdraws pending questions; answers never
   * address another caller's attempt. Provider errors expose only safe codes.
   * @param scope - credential owner's scope.
   * @param id - credential identity within that scope.
   * @param method - one method declared by the registered flow.
   * @param signal - connection and caller cancellation.
   * @returns progress, questions, and one terminal outcome; reads question answers on its uplink.
   */
  @Remote({ mode: 'stream' })
  signIn(scope: string, id: string, method: string, signal: AbortSignal): RemoteStream<AuthorizationFrame, AuthorizationReply> {
    const invocation = this.ctx.invocation
    if (invocation === undefined) throw new Error('authorization.signIn requires a Remote invocation')
    const { authorization } = this.provider()
    const key = keyFor(scope, id)
    return converse(authorization, key, method, invocation.uplink<AuthorizationReply>(), signal)
  }

  /**
   * Remove only the credential owned by a registered flow, keeping API-key
   * references and host identity records. An in-flight login must finish first.
   * @param scope - credential owner's scope.
   * @param id - credential identity within that scope.
   * @returns after local credential removal commits; does not revoke the remote account grant.
   */
  @Remote
  async signOut(scope: string, id: string): Promise<void> {
    const key = keyFor(scope, id)
    const { authorization, credentials } = this.provider()
    const flow = authorization.describe(key)
    if (flow === undefined || flow.inFlight) {
      throw new RemoteError('authorization/rejected', 'Finish or cancel sign-in before disconnecting.', { code: flow === undefined ? 'NO_FLOW' : 'ALREADY_IN_FLIGHT' })
    }
    try { await credentials.deleteRecord(key) }
    catch (error) {
      throw new RemoteError('authorization/rejected', 'Could not remove the stored connection. Try again.', { code: 'SIGN_OUT_FAILED' }, { cause: error })
    }
  }

  private provider(): { authorization: AuthorizationService; credentials: CredentialProvider } {
    const authorization = this.ctx.get('authorization')
    const credentials = this.ctx.get('credentials')
    if (authorization === undefined || credentials === undefined) {
      throw new RemoteError('authorization/rejected', 'Authorization and credential storage are required in this profile.', { code: 'NO_AUTHORIZATION' })
    }
    return { authorization, credentials }
  }
}

/** One stream owns its queue, questions, cancellation, and answer reader. */
async function* converse(
  authorization: AuthorizationService,
  key: CredentialKey,
  method: string,
  uplink: AsyncIterable<AuthorizationReply>,
  signal: AbortSignal,
): AsyncGenerator<AuthorizationFrame> {
  const lifetime = new AbortController()
  const active = AbortSignal.any([signal, lifetime.signal])
  const queue: AuthorizationFrame[] = []
  const pending = new Map<AuthorizationPromptId, (value: string) => void>()
  let wake = Promise.withResolvers<void>()
  const lifecycle = { finished: false }
  const push = (frame: AuthorizationFrame): void => { queue.push(frame); wake.resolve() }
  const ask = async (prompt: AuthorizationPrompt): Promise<string> => {
    const cancelled = prompt.signal === undefined ? active : AbortSignal.any([active, prompt.signal])
    cancelled.throwIfAborted()
    const id = randomUUID() as AuthorizationPromptId
    const answer = Promise.withResolvers<string>()
    const abort = (): void => { push({ type: 'withdraw', id }); answer.reject(new Error('Authorization question withdrawn')) }
    pending.set(id, answer.resolve)
    cancelled.addEventListener('abort', abort, { once: true })
    push({ type: 'prompt', id, prompt: question(prompt) })
    try {
      const value = await answer.promise
      if (prompt.kind === 'select' && !prompt.options.some(option => option.id === value)) {
        throw new AuthorizationError('Invalid authorization choice.', 'INVALID_RESPONSE')
      }
      return value
    } finally {
      pending.delete(id)
      cancelled.removeEventListener('abort', abort)
    }
  }
  const input = uplink[Symbol.asyncIterator]()
  const reading = (async () => {
    while (!active.aborted) {
      const next = await input.next()
      if (next.done) { lifetime.abort(); return }
      // A callback may withdraw a question before its already-sent answer arrives.
      pending.get(next.value.id)?.(next.value.value)
    }
  })().catch(() => { lifetime.abort() })
  const running = authorization.begin({
    key, method, signal: active,
    interaction: { notify: (notice) => { if (!active.aborted) push({ type: 'notice', notice }) }, prompt: ask },
  }).then(
    (outcome) => { push({ type: 'settled', outcome }) },
    (error: unknown) => { push({ type: 'failed', code: error instanceof AuthorizationError ? error.code : 'SIGN_IN_FAILED' }) },
  ).finally(() => { lifecycle.finished = true; wake.resolve() })
  try {
    while (!lifecycle.finished || queue.length > 0) {
      const frame = queue.shift()
      if (frame !== undefined) { yield frame; continue }
      await wake.promise
      wake = Promise.withResolvers<void>()
    }
  } finally {
    lifetime.abort()
    // The Gateway's uplink return settles its outstanding next() before resolving.
    await input.return?.()
    await Promise.all([running, reading])
  }
}

export default AuthorizationController
