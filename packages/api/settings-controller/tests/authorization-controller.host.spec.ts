/** Caller-owned Remote authorization: interaction, cancellation, and secret-free status. */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { ownerPeer } from '../../gateway/tests/peer.ts'
import AuthorizationController from '../src/authorization.ts'
import type { AuthorizationFrame, AuthorizationReply } from '../src/types.ts'

const KEY = credentialKey('llm-pi-ai', 'openai')
const roots: Context[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose())) })

class RefusedDeletion extends MemoryCredentials {
  override deleteRecord(): Promise<void> { return Promise.reject(new Error('storage unavailable')) }
}

async function harness(provider: typeof MemoryCredentials = MemoryCredentials): Promise<Context> {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(provider, { OPENAI_API_KEY: 'api-key-kept' })
  await ctx.plugin(AuthorizationService)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(RemoteAccessService)
  await ctx.plugin(TypertGatewayService, {})
  await ctx.plugin(AuthorizationController)
  return ctx
}

async function open(ctx: Context, signal?: AbortSignal, method = 'oauth') {
  const input = new TransformStream<AuthorizationReply, AuthorizationReply>()
  const writer = input.writable.getWriter()
  const frames = await ctx.typertGateway.stream({
    peer: ownerPeer(ctx), namespace: 'authorization', method: 'signIn',
    args: { scope: 'llm-pi-ai', id: 'openai', method }, uplink: input.readable,
    ...signal === undefined ? {} : { signal },
  })
  return { writer, frames: frames as AsyncIterable<AuthorizationFrame, undefined> }
}

async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = []
  for await (const item of items) result.push(item)
  return result
}

function register(ctx: Context, run: Parameters<AuthorizationService['registerFlow']>[0]['run']) {
  return ctx.authorization.registerFlow({ key: KEY, label: 'OpenAI', methods: [{ id: 'oauth', label: 'ChatGPT' }], run })
}

const grant = { kind: 'grant' as const, payload: { access: 'access-secret', refresh: 'refresh-secret' } }

describe('authorization Remote controller', () => {
  it('describes only registered flows and never returns stored grants', async () => {
    const ctx = await harness()
    expect(await ctx.authorizationController.describe('llm-pi-ai', 'openai')).toBeNull()
    const dispose = register(ctx, async (session) => { await session.commit(grant) })
    expect(await ctx.authorizationController.describe('llm-pi-ai', 'openai')).toMatchObject({ kind: null })
    await ctx.credentials.modifyRecord(KEY, () => Promise.resolve(grant))
    const view = await ctx.authorizationController.describe('llm-pi-ai', 'openai')
    expect(view).toEqual({ methods: [{ id: 'oauth', label: 'ChatGPT' }], kind: 'grant', inFlight: false, writable: true })
    expect(JSON.stringify(view)).not.toContain('secret')
    await expect(ctx.authorizationController.describe('../invalid', 'openai')).rejects.toMatchObject({ code: 'gateway/bad-request' })
    dispose()
    expect(await ctx.authorizationController.describe('llm-pi-ai', 'openai')).toBeNull()
  })

  it('relays a prompt and commits its answer through the real authorization service', async () => {
    const ctx = await harness()
    register(ctx, async (session) => {
      session.notify({ message: 'Open ChatGPT', url: 'https://auth.openai.com/' })
      const selected = await session.prompt({ kind: 'select', message: 'Account', options: [{ id: 'work', label: 'Work', description: 'Work account' }] })
      expect(selected).toBe('work')
      await session.commit(grant)
    })
    const { frames, writer } = await open(ctx)
    const iterator = frames[Symbol.asyncIterator]()
    expect((await iterator.next()).value).toEqual({ type: 'notice', notice: { message: 'Open ChatGPT', url: 'https://auth.openai.com/' } })
    const frame = (await iterator.next()).value
    if (frame?.type !== 'prompt') throw new Error('expected authorization question')
    expect(frame.prompt).not.toHaveProperty('signal')
    await writer.write({ id: frame.id, value: 'work' })
    expect((await iterator.next()).value).toEqual({ type: 'settled', outcome: { status: 'authorized' } })
    expect((await iterator.next()).done).toBe(true)
    expect(await ctx.credentials.readRecord(KEY)).toEqual(grant)
  })

  it('withdraws the manual question when the browser callback wins', async () => {
    const ctx = await harness()
    const callback = new AbortController()
    register(ctx, async (session) => {
      try { await session.prompt({ kind: 'text', message: 'Paste callback URL', placeholder: 'http://127.0.0.1:1455/auth/callback', signal: callback.signal }) }
      catch (error) { if (!callback.signal.aborted) throw error }
      await session.commit(grant)
    })
    const { frames } = await open(ctx)
    const iterator = frames[Symbol.asyncIterator]()
    const frame = (await iterator.next()).value
    if (frame?.type !== 'prompt') throw new Error('expected authorization question')
    callback.abort()
    expect((await iterator.next()).value).toEqual({ type: 'withdraw', id: frame.id })
    expect((await iterator.next()).value).toEqual({ type: 'settled', outcome: { status: 'authorized' } })
    expect((await iterator.next()).done).toBe(true)
  })

  it('contains provider error details and rejects undeclared login methods', async () => {
    const ctx = await harness()
    register(ctx, () => Promise.reject(new Error('access-secret refresh-secret')))
    expect(await collect((await open(ctx)).frames)).toEqual([{ type: 'failed', code: 'SIGN_IN_FAILED' }])
    expect(await collect((await open(ctx, undefined, 'unknown')).frames)).toEqual([{ type: 'failed', code: 'UNKNOWN_METHOD' }])
    expect(await ctx.credentials.readRecord(KEY)).toBeUndefined()
  })

  it('refuses a second caller and disconnect while a login is pending', async () => {
    const ctx = await harness()
    register(ctx, async (session) => {
      await session.prompt({ kind: 'secret', message: 'One-time code' })
      await session.commit(grant)
    })
    const first = await open(ctx)
    const iterator = first.frames[Symbol.asyncIterator]()
    const prompt = (await iterator.next()).value
    if (prompt?.type !== 'prompt') throw new Error('expected authorization question')
    expect(await collect((await open(ctx)).frames)).toEqual([{ type: 'failed', code: 'ALREADY_IN_FLIGHT' }])
    await expect(ctx.authorizationController.signOut('llm-pi-ai', 'openai')).rejects.toMatchObject({ details: { code: 'ALREADY_IN_FLIGHT' } })
    await first.writer.write({ id: prompt.id, value: 'code' })
    expect((await iterator.next()).value).toEqual({ type: 'settled', outcome: { status: 'authorized' } })
    expect((await iterator.next()).done).toBe(true)
  })

  it('cancels pending questions on caller disconnect without saving a grant', async () => {
    const ctx = await harness()
    const stopped = Promise.withResolvers<undefined>()
    register(ctx, async (session) => {
      try { await session.prompt({ kind: 'text', message: 'Paste callback' }); await session.commit(grant) }
      finally { session.notify({ message: 'Late provider notice' }); stopped.resolve(undefined) }
    })
    const cancel = new AbortController()
    const { frames } = await open(ctx, cancel.signal)
    const iterator = frames[Symbol.asyncIterator]()
    expect((await iterator.next()).value).toMatchObject({ type: 'prompt' })
    cancel.abort()
    await iterator.next().catch(() => ({ done: true }))
    await iterator.return?.()
    await stopped.promise
    expect(ctx.authorization.describe(KEY)?.inFlight).toBe(false)
    expect(await ctx.credentials.readRecord(KEY)).toBeUndefined()
  })

  it('rejects a choice the flow did not offer without committing a credential', async () => {
    const ctx = await harness()
    register(ctx, async (session) => {
      await session.prompt({ kind: 'select', message: 'Account', options: [{ id: 'work', label: 'Work' }] })
      await session.commit(grant)
    })
    const { frames, writer } = await open(ctx)
    const iterator = frames[Symbol.asyncIterator]()
    const frame = (await iterator.next()).value
    if (frame?.type !== 'prompt') throw new Error('expected authorization question')
    await writer.write({ id: frame.id, value: 'unlisted' })
    expect((await iterator.next()).value).toEqual({ type: 'failed', code: 'INVALID_RESPONSE' })
    expect((await iterator.next()).done).toBe(true)
    expect(await ctx.credentials.readRecord(KEY)).toBeUndefined()
  })

  it('reports unavailable composition and direct calls without a Remote invocation', async () => {
    const ctx = new Context()
    roots.push(ctx)
    await ctx.plugin(AuthorizationController)
    expect(await ctx.authorizationController.describe('llm-pi-ai', 'openai')).toBeNull()
    await expect(ctx.authorizationController.signOut('llm-pi-ai', 'openai')).rejects.toMatchObject({ details: { code: 'NO_AUTHORIZATION' } })
    expect(() => ctx.authorizationController.signIn('llm-pi-ai', 'openai', 'oauth', new AbortController().signal)).toThrow('Remote invocation')
  })

  it('reports a failed local disconnect without losing the stored grant', async () => {
    const ctx = await harness(RefusedDeletion)
    register(ctx, async (session) => { await session.commit(grant) })
    await ctx.credentials.modifyRecord(KEY, () => Promise.resolve(grant))
    await expect(ctx.authorizationController.signOut('llm-pi-ai', 'openai')).rejects.toMatchObject({ details: { code: 'SIGN_OUT_FAILED' } })
    expect(await ctx.credentials.readRecord(KEY)).toEqual(grant)
  })

  it('disconnects only the flow-owned grant and preserves independent credentials', async () => {
    const ctx = await harness()
    register(ctx, async (session) => { await session.commit(grant) })
    await ctx.credentials.modifyRecord(KEY, () => Promise.resolve(grant))
    const device = credentialKey('llm-pi-ai-device', 'openai')
    await ctx.credentials.modifyRecord(device, () => Promise.resolve({ kind: 'grant', payload: { deviceId: 'kept' } }))
    await ctx.authorizationController.signOut('llm-pi-ai', 'openai')
    expect(await ctx.credentials.readRecord(KEY)).toBeUndefined()
    expect(await ctx.credentials.readRecord(device)).toBeDefined()
    expect((await ctx.credentials.resolve(credentialRef('OPENAI_API_KEY')))?.value).toBe('api-key-kept')
    await expect(ctx.authorizationController.signOut('llm-pi-ai-device', 'openai')).rejects.toMatchObject({ details: { code: 'NO_FLOW' } })
  })
})
