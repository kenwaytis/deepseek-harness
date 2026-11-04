/** ChatGPT subscription authentication never falls back to API-key billing. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '../src/index.ts'
import { authContextFrom, credentialStoreFrom, recordKeyFor } from '../src/auth.ts'
import * as catalog from '../src/catalog.ts'
import { buildProvider } from '../src/provider.ts'
import { discoverChatGptModels } from '../src/discovery.ts'
import { resolveProfiles } from '../src/config.ts'
import type { PiAiProviderProfile } from '../src/config.ts'
import { openAiDeviceId } from '../src/device.ts'
import { assemble } from './assemble.ts'

const roots: Context[] = []
const dirs: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function harness(path?: string): Promise<Context> {
  if (path === undefined) {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-chatgpt-'))
    dirs.push(dir)
    path = join(dir, '.credentials.yaml')
  }
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(LocalCredentialProvider, { path, watch: false })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmPiAi, { providers: { openai: { auth: 'chatgpt', models: [{ id: 'gpt-4.1' }], transport: 'sse' } } })
  return ctx
}

async function grant(ctx: Context, expired = false): Promise<void> {
  await ctx.credentials.modifyRecord(recordKeyFor('openai'), () => Promise.resolve({ kind: 'grant', payload: {
    type: 'oauth', access: 'subscription-access', refresh: 'refresh-original',
    expires: expired ? 0 : Date.now() + 3_600_000, clientId: 'issued-client', scopes: ['chatgpt.tokens.use.direct'],
  } }))
}

function responseStream(): Response {
  const item = { type: 'message', id: 'msg_reply', role: 'assistant', content: [{ type: 'output_text', text: 'subscription reply', annotations: [] }] }
  const events = [
    { type: 'response.created', response: { id: 'response-subscription' } },
    { type: 'response.output_item.added', output_index: 0, item },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: 'response-subscription', status: 'completed', output: [item], usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 } } },
  ]
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
}

describe('ChatGPT subscription', () => {
  it('keeps OAuth as the only authentication method and rejects conflicting configuration', () => {
    const profile = resolveProfiles({ openai: { auth: 'chatgpt' } }).get('openai')!
    expect(Object.keys(profile.piProvider!.auth)).toEqual(['oauth'])
    const invalid: PiAiProviderProfile[] = [
      { auth: 'chatgpt', apiKeyEnv: 'OPENAI_API_KEY' },
      { auth: 'chatgpt', baseURL: 'https://proxy.example/v1' },
      { auth: 'chatgpt', api: 'openai-completions' },
      { auth: 'chatgpt', headers: { aUtHoRiZaTiOn: 'Bearer unrelated' } },
      { auth: 'chatgpt', compat: { supportsStore: false } },
      { auth: 'chatgpt', models: [{ id: 'gpt-4.1', compat: { supportsStore: false } }] },
      { auth: 'chatgpt', modelOverrides: { 'gpt-4.1': { compat: { supportsStore: false } } } },
    ]
    for (const source of invalid) expect(() => resolveProfiles({ openai: source })).toThrow(/chatgpt/)
    expect(() => resolveProfiles({ anthropic: { auth: 'chatgpt' } })).toThrow(/openai/)
    expect(() => buildProvider({ provider: 'unknown-route', displayName: 'Unknown', api: 'openai-responses', namesCredential: false, models: [], auth: 'chatgpt' })).toThrow('OAuth is unavailable')
  })

  it('shares one host UUID across credential-store instances and preserves it after sign-out', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-chatgpt-shared-'))
    dirs.push(dir)
    const path = join(dir, '.credentials.yaml')
    const first = await harness(path)
    const second = await harness(path)
    const ids = await Promise.all([openAiDeviceId(first), openAiDeviceId(second)])
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/)
    expect(ids[1]).toBe(ids[0])
    await grant(first)
    await first.credentials.deleteRecord(recordKeyFor('openai'))
    const restarted = await harness(path)
    expect(await openAiDeviceId(restarted)).toBe(ids[0])
  })

  it('refuses corrupt host identity instead of silently replacing it', async () => {
    const ctx = await harness()
    const key = credentialKey('llm-pi-ai-device', 'openai')
    await ctx.credentials.modifyRecord(key, () => Promise.resolve({ kind: 'grant', payload: { deviceId: 'broken' } }))
    await expect(openAiDeviceId(ctx)).rejects.toMatchObject({ code: 'INVALID_DEVICE_ID' })
    expect(await ctx.credentials.readRecord(key)).toEqual({ kind: 'grant', payload: { deviceId: 'broken' } })
    await ctx.credentials.modifyRecord(key, () => Promise.resolve({ kind: 'api-key', key: 'not-a-host-identity' }))
    await expect(openAiDeviceId(ctx)).rejects.toMatchObject({ code: 'INVALID_DEVICE_ID' })
    await expect(openAiDeviceId(new Context())).rejects.toMatchObject({ code: 'NO_CREDENTIAL_STORE' })
  })

  it('uses only the subscription token at the official streaming Responses endpoint', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'unrelated-billable-key')
    const ctx = await harness()
    await grant(ctx)
    const requests: Request[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      requests.push(new Request(input, init))
      return Promise.resolve(responseStream())
    })
    const result = await assemble(ctx, { provider: 'openai', model: 'gpt-4.1', messages: [] })
    expect(result.finish).toEqual({ kind: 'stop' })
    expect(result.message.content).toEqual([{ type: 'text', text: 'subscription reply' }])
    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toBe('https://api.openai.com/v1/responses')
    expect(requests[0]!.headers.get('authorization')).toBe('Bearer subscription-access')
    expect(await requests[0]!.json()).toMatchObject({ store: false, stream: true, model: 'gpt-4.1' })
  })

  it('lists the signed-in account models rather than the API-key catalog', async () => {
    const ctx = await harness()
    await grant(ctx)
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const request = new Request(input, init)
      expect(request.url).toBe('https://api.openai.com/v1/models')
      expect(request.headers.get('authorization')).toBe('Bearer subscription-access')
      return Promise.resolve(Response.json({ models: [
        { slug: 'gpt-4.1', display_name: 'My GPT', visibility: 'list' },
        { slug: 'hidden', display_name: 'Hidden', visibility: 'hide' },
        { slug: 'gpt-new-subscription', display_name: 'New GPT', visibility: 'list' },
      ] }))
    })
    const models = await ctx.llm.discoverModels('llm-pi-ai', { provider: 'openai' }, new AbortController().signal)
    expect(models.map(model => [model.id, model.name])).toEqual([['gpt-4.1', 'My GPT'], ['gpt-new-subscription', 'New GPT']])
    expect(fetch).toHaveBeenCalledOnce()
    fetch.mockResolvedValueOnce(Response.json({ error: 'account unavailable' }, { status: 403 }))
    await expect(ctx.llm.discoverModels('llm-pi-ai', { provider: 'openai' })).rejects.toMatchObject({ code: 'DISCOVERY_FAILED' })
  })

  it('refuses subscription discovery without a grant or an installed OAuth provider', async () => {
    const ctx = await harness()
    const auth = { credentials: credentialStoreFrom(ctx), authContext: authContextFrom(ctx) }
    const fetch = vi.spyOn(globalThis, 'fetch')
    await expect(discoverChatGptModels(auth)).rejects.toMatchObject({ code: 'MISSING_CREDENTIAL' })
    vi.spyOn(catalog, 'catalogProvider').mockReturnValueOnce(undefined)
    await expect(discoverChatGptModels(auth)).rejects.toMatchObject({ code: 'DISCOVERY_FAILED' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    'not JSON', 'null', '{"models":{}}', '{"models":[null]}',
    '{"models":[{"slug":"","display_name":"Bad","visibility":"list"}]}',
  ])('rejects an invalid account model listing: %s', async (body) => {
    const ctx = await harness()
    await grant(ctx)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body, { headers: { 'content-type': 'application/json' } }))
    await expect(ctx.llm.discoverModels('llm-pi-ai', { provider: 'openai' })).rejects.toMatchObject({ code: 'DISCOVERY_FAILED' })
  })

  it('persists a rotated refresh token before concurrent requests use it', async () => {
    const ctx = await harness()
    await grant(ctx, true)
    let refreshes = 0
    const requests: Request[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init)
      if (request.url === 'https://auth.openai.com/api/accounts/oauth/token') {
        refreshes++
        const body = new URLSearchParams(await request.text())
        expect(body.get('client_id')).toBe('issued-client')
        expect(body.get('refresh_token')).toBe('refresh-original')
        return Response.json({ access_token: 'subscription-rotated', refresh_token: 'refresh-rotated', expires_in: 3600, scope: 'chatgpt.tokens.use.direct' })
      }
      requests.push(request)
      return responseStream()
    })
    const replies = await Promise.all([1, 2].map(() => assemble(ctx, { provider: 'openai', model: 'gpt-4.1', messages: [] })))
    expect(replies.every(reply => reply.finish.kind === 'stop')).toBe(true)
    expect(refreshes).toBe(1)
    expect(requests.map(request => request.headers.get('authorization'))).toEqual(['Bearer subscription-rotated', 'Bearer subscription-rotated'])
    expect(await ctx.credentials.readRecord(recordKeyFor('openai'))).toMatchObject({ kind: 'grant', payload: { access: 'subscription-rotated', refresh: 'refresh-rotated', clientId: 'issued-client' } })
  })

  it('offers no models and makes no request after disconnect, even with an ambient API key', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'unrelated-billable-key')
    const ctx = await harness()
    await grant(ctx)
    await ctx.credentials.deleteRecord(recordKeyFor('openai'))
    const fetch = vi.spyOn(globalThis, 'fetch')
    expect(await ctx.llm.listModels('openai')).toEqual([])
    const result = await assemble(ctx, { provider: 'openai', model: 'gpt-4.1', messages: [] })
    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'MISSING_CREDENTIAL' } })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not retry a refused OAuth refresh with an API key', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'unrelated-billable-key')
    const ctx = await harness()
    await grant(ctx, true)
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ error: 'invalid_grant' }, { status: 400 }))
    const result = await assemble(ctx, { provider: 'openai', model: 'gpt-4.1', messages: [] })
    expect(result.finish.kind).toBe('error')
    expect(fetch).toHaveBeenCalledTimes(1)
    const [input, init] = fetch.mock.calls[0]!
    expect(new Request(input, init).url).toBe('https://auth.openai.com/api/accounts/oauth/token')
    expect(await ctx.credentials.readRecord(recordKeyFor('openai'))).toMatchObject({ payload: { refresh: 'refresh-original' } })
  })
})
