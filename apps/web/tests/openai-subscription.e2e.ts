/** Native ChatGPT login through the shipped Host, Remote stream, and Models UI. */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { openSettings } from './support.ts'

const EXPECTED = fileURLToPath(new URL('./expected/openai-subscription', import.meta.url))
const MODE = webSnapshotMode()
const TOKEN = 'web-subscription-access'

// Only OpenAI's external authorization server and inference API are doubled.
// pi-ai owns its protocol-required 1455 callback listener; the real browser uses it.
describe('web e2e: native ChatGPT subscription', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let originalFetch: typeof fetch
  let authorize: URL | undefined
  const inference: Request[] = []

  beforeAll(async () => {
    vi.stubEnv('OPENAI_API_KEY', 'billable-key-must-not-be-used')
    scaffold = await launchWebScaffold({})
    originalFetch = globalThis.fetch
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input, init)
      if (request.url === 'https://auth.openai.com/api/accounts/oauth/token') {
        const body = new URLSearchParams(await request.text())
        expect(body.get('grant_type')).toBe('authorization_code')
        expect(body.get('client_id')).toBe('issued-web-client')
        expect(body.get('code')).toBe('approved-code')
        expect(createHash('sha256').update(body.get('code_verifier') ?? '').digest('base64url')).toBe(authorize?.searchParams.get('code_challenge'))
        return Response.json({ access_token: TOKEN, refresh_token: 'web-refresh-token', expires_in: 3600,
          scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct', id_token: 'test-identity-token' })
      }
      if (request.url === 'https://api.openai.com/v1/models') {
        expect(request.headers.get('authorization')).toBe(`Bearer ${TOKEN}`)
        return Response.json({ models: [
          { slug: 'gpt-4.1', display_name: 'Subscription GPT', visibility: 'list' },
          { slug: 'hidden-model', display_name: 'Hidden GPT', visibility: 'hide' },
        ] })
      }
      if (request.url === 'https://api.openai.com/v1/responses') {
        inference.push(request)
        const item = { type: 'message', id: 'message-subscription', role: 'assistant', content: [{ type: 'output_text', text: 'SUBSCRIPTION_OK', annotations: [] }] }
        const events = [
          { type: 'response.created', response: { id: 'response-subscription' } },
          { type: 'response.output_item.added', output_index: 0, item },
          { type: 'response.output_item.done', output_index: 0, item },
          { type: 'response.completed', response: { id: 'response-subscription', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
        ]
        return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
      }
      return originalFetch(input, init)
    })
    browser = await chromium.launch()
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: 'en-US' })
    await context.route('https://auth.openai.com/api/accounts/authorize?*', async (route) => {
      authorize = new URL(route.request().url())
      expect(authorize.searchParams.get('agent_name_hint')).toBe('DeepSeek Harness')
      expect(authorize.searchParams.get('ext_agent_host_id')).toMatch(/^urn:uuid:/)
      expect(authorize.searchParams.get('scope')).toContain('chatgpt.tokens.use.direct')
      const callback = new URL(authorize.searchParams.get('redirect_uri') ?? '')
      callback.searchParams.set('code', 'approved-code')
      callback.searchParams.set('state', authorize.searchParams.get('state') ?? '')
      callback.searchParams.set('client_id', 'issued-web-client')
      await route.fulfill({ status: 302, headers: { location: callback.href } })
    })
    page = await context.newPage()
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await openSettings(page, 'en')
    await page.getByRole('dialog', { name: 'Settings', exact: true }).getByRole('button', { name: 'Models', exact: true }).click()
  })

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it('authorizes in a browser, saves account models, and dispatches with subscription credentials', async () => {
    const card = page.getByRole('region', { name: 'ChatGPT subscription', exact: true })
    await card.getByRole('button', { name: 'Continue with ChatGPT', exact: true }).click()
    const popup = page.context().waitForEvent('page')
    await card.getByRole('link', { name: 'Open sign-in page', exact: true }).click()
    const authorization = await popup
    await authorization.waitForURL(url => url.pathname === '/auth/callback', { timeout: 30_000 })
    await card.getByText('Using your ChatGPT plan', { exact: true }).waitFor({ timeout: 30_000 })
    expect(await authorization.evaluate(() => window.opener === null)).toBe(true)
    await authorization.close()
    const stored = await scaffold.ctx.credentials.readRecord(credentialKey('llm-pi-ai', 'openai'))
    expect(stored).toMatchObject({ kind: 'grant', payload: { type: 'oauth', access: TOKEN, refresh: 'web-refresh-token', clientId: 'issued-web-client' } })
    const patch = await readFile(join(scaffold.harnessHome, 'profiles/scaffold/cordis.patch.yml'), 'utf8')
    expect(patch).toContain('auth: chatgpt')
    expect(patch).not.toContain(TOKEN)
    expect(await page.content()).not.toContain(TOKEN)
    expect(await scaffold.ctx.llm.listModels('openai')).toMatchObject([{ id: 'gpt-4.1', name: 'Subscription GPT' }])
    const result = new BlockAssembler()
    for await (const chunk of scaffold.ctx.llm.stream({ provider: 'openai', model: 'gpt-4.1', messages: [] })) result.push(chunk)
    expect(result.finish).toEqual({ kind: 'stop' })
    expect(inference).toHaveLength(1)
    expect(inference[0]!.headers.get('authorization')).toBe(`Bearer ${TOKEN}`)
    expect(await inference[0]!.json()).toMatchObject({ store: false, stream: true })
    await compareOrRefreshGolden(join(EXPECTED, 'connected.expected.md'), await captureStableAria(page, 'section[aria-label="ChatGPT subscription"]', scaffold.workspaceCwd), MODE)
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      expect(await card.getByRole('button', { name: 'Disconnect', exact: true }).isEnabled()).toBe(true)
    }
  })

  it('disconnects without exposing tokens or falling back to an existing API key', async () => {
    const card = page.getByRole('region', { name: 'ChatGPT subscription', exact: true })
    await card.getByRole('button', { name: 'Disconnect', exact: true }).click()
    await card.getByRole('button', { name: 'Continue with ChatGPT', exact: true }).waitFor()
    await expect.poll(async () => (await scaffold.ctx.llm.listModels('openai')).length).toBe(0)
    expect(await scaffold.ctx.credentials.readRecord(credentialKey('llm-pi-ai', 'openai'))).toBeUndefined()
    expect(await scaffold.ctx.credentials.readRecord(credentialKey('llm-pi-ai-device', 'openai'))).toBeDefined()
    await compareOrRefreshGolden(join(EXPECTED, 'disconnected.expected.md'), await captureStableAria(page, 'section[aria-label="ChatGPT subscription"]', scaffold.workspaceCwd), MODE)
    expect(tripwire.pageErrors).toEqual([])
  })
})
