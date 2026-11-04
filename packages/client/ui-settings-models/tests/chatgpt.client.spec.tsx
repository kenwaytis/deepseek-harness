// @vitest-environment jsdom
/** Subscription setup keeps OAuth tokens on the Host and activates an OAuth-only profile. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { RemoteError, TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import type { AuthorizationFrame, AuthorizationPromptId, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { ChatGptConnection } from '../src/client/chatgpt.ts'
import type { ChatGptState } from '../src/client/chatgpt.ts'
import { ChatGptCard } from '../src/client/ChatGptCard.tsx'
import { en } from '../src/client/locales.ts'
import { providerUsable } from '../src/client/store.ts'
import type { ProviderRow } from '../src/client/store.ts'

const contexts: Context[] = []
const connections: ChatGptConnection[] = []
afterEach(async () => {
  cleanup()
  await Promise.all(connections.splice(0).map(connection => connection.dispose()))
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

const namespace: SettingsNamespaceView = {
  ns: 'llm-pi-ai', schema: {}, value: {}, user: {}, secrets: [], autoGenerate: false, applies: 'live', revision: 7,
}
const row: ProviderRow = {
  entry: { provider: 'openai', displayName: 'OpenAI', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'], active: true },
  configured: true, removable: true, apiKeyEnv: undefined, credential: undefined, subscription: true,
  authorization: { methods: [{ id: 'oauth', label: 'ChatGPT' }], kind: 'grant', inFlight: false, writable: true },
}
const promptId = 'callback-question' as AuthorizationPromptId

function setup(frames: AuthorizationFrame[] = [{ type: 'settled', outcome: { status: 'authorized' } }]) {
  const ctx = new Context()
  contexts.push(ctx)
  const end = Promise.withResolvers<undefined>()
  const dispose = vi.fn(() => { end.resolve(undefined) })
  const send = vi.fn()
  const stream: ReturnType<Context['remote']['authorization']['signIn']> = {
    async *[Symbol.asyncIterator]() { for (const frame of frames) yield frame; await end.promise },
    dispose, send, end: () => { end.resolve(undefined) },
  }
  if (frames.some(frame => frame.type === 'settled' || frame.type === 'failed')) end.resolve(undefined)
  const signIn = vi.fn(() => stream)
  const signOut = vi.fn<Context['remote']['authorization']['signOut']>(async () => ({ ok: true, value: undefined }))
  const discover = vi.fn<Context['remote']['llm']['discoverModels']>(async () => ({ ok: true, value: [{ id: 'gpt-account', name: 'Account GPT' }] }))
  const mutate = vi.fn<Context['remote']['settings']['mutate']>(async () => ({ ok: true, value: namespace }))
  new TestRemote(ctx, { authorization: { signIn, signOut }, llm: { discoverModels: discover }, settings: { mutate } })
  const load = vi.fn(async () => {})
  const connection = new ChatGptConnection(ctx, { load })
  connections.push(connection)
  return { connection, signIn, signOut, discover, mutate, load, send, dispose, stream }
}

async function idle(connection: ChatGptConnection) {
  await vi.waitFor(() => { expect(connection.store.getSnapshot().status).toBe('idle') })
}

describe('ChatGPT connection', () => {
  it('saves account-visible models and explicitly removes API-key and proxy routing', async () => {
    const { connection, signIn, discover, mutate, load } = setup()
    connection.actions.connect(namespace, false)
    await idle(connection)
    expect(signIn).toHaveBeenCalledWith('llm-pi-ai', 'openai', 'oauth', expect.any(AbortSignal))
    expect(discover).toHaveBeenCalledWith('llm-pi-ai', { provider: 'openai' }, expect.any(AbortSignal))
    expect(mutate).toHaveBeenCalledWith('llm-pi-ai', [
      { op: 'set', path: ['providers', 'openai', 'auth'], value: 'chatgpt' },
      { op: 'set', path: ['providers', 'openai', 'models'], value: [{ id: 'gpt-account', name: 'Account GPT' }] },
      ...['apiKeyEnv', 'api', 'baseURL', 'modelOverrides'].map(field => ({ op: 'unset', path: ['providers', 'openai', field] })),
    ], 7)
    expect(load).toHaveBeenCalledOnce()
    expect(connection.store.getSnapshot().failure).toBeNull()
  })

  it('retries setup with the saved grant without repeating browser registration', async () => {
    const { connection, signIn, discover } = setup()
    connection.actions.connect(namespace, true)
    await idle(connection)
    expect(signIn).not.toHaveBeenCalled()
    expect(discover).toHaveBeenCalledOnce()
  })

  it('keeps the saved login available for setup retry after discovery or settings refusal', async () => {
    const first = setup()
    first.discover.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'listing unavailable', {}) })
    first.connection.actions.connect(namespace, true)
    await idle(first.connection)
    expect(first.connection.store.getSnapshot().failure).toBe('models')
    expect(first.mutate).not.toHaveBeenCalled()
    const second = setup()
    second.mutate.mockResolvedValueOnce({ ok: false, error: new RemoteError('settings/conflict', 'stale', { ns: namespace.ns, expected: 7, actual: 8 }) })
    second.connection.actions.connect(namespace, true)
    await idle(second.connection)
    expect(second.connection.store.getSnapshot().failure).toBe('settings')
  })

  it('keeps configuration untouched after a cancelled or failed login', async () => {
    for (const frame of [{ type: 'settled', outcome: { status: 'cancelled' } }, { type: 'failed', code: 'SIGN_IN_FAILED' }] as AuthorizationFrame[]) {
      const { connection, discover, mutate } = setup([frame])
      connection.actions.connect(namespace, false)
      await idle(connection)
      expect(discover).not.toHaveBeenCalled()
      expect(mutate).not.toHaveBeenCalled()
    }
  })

  it('answers only on the owning stream and cancels it to completion', async () => {
    const frame: AuthorizationFrame = { type: 'prompt', id: promptId, prompt: { kind: 'text', message: 'Paste callback URL' } }
    const { connection, send, dispose, mutate } = setup([frame])
    connection.actions.connect(namespace, false)
    await vi.waitFor(() => { expect(connection.store.getSnapshot().prompt).toEqual(frame) })
    connection.actions.answer({ id: promptId, value: 'callback-url' })
    expect(send).toHaveBeenCalledWith({ id: promptId, value: 'callback-url' })
    await connection.dispose()
    expect(dispose).toHaveBeenCalled()
    expect(connection.store.getSnapshot()).toMatchObject({ status: 'idle', prompt: null, notice: null })
    expect(mutate).not.toHaveBeenCalled()
  })

  it('keeps one attempt while multiple controls are clicked', async () => {
    const test = setup([{ type: 'prompt', id: promptId, prompt: { kind: 'text', message: 'Callback' } }])
    test.connection.actions.connect(namespace, false)
    test.connection.actions.connect(namespace, false)
    test.connection.actions.disconnect()
    expect(test.signIn).toHaveBeenCalledOnce()
    expect(test.signOut).not.toHaveBeenCalled()
    await test.connection.dispose()
  })

  it.each(['matching', 'stale', 'absent'] as const)('withdraws only the matching question: %s', async (mode) => {
    const notice = { message: 'Approve in browser', url: 'https://auth.openai.com' }
    const frames: AuthorizationFrame[] = [{ type: 'notice', notice }]
    if (mode !== 'absent') frames.push({ type: 'prompt', id: promptId, prompt: { kind: 'text', message: 'Callback' } })
    frames.push({ type: 'withdraw', id: mode === 'stale' ? 'stale-question' as AuthorizationPromptId : promptId })
    const { connection } = setup(frames)
    connection.actions.connect(namespace, false)
    await vi.waitFor(() => {
      expect(connection.store.getSnapshot().notice).toEqual(notice)
      expect(connection.store.getSnapshot().prompt?.id ?? null).toBe(mode === 'stale' ? promptId : null)
    })
    await connection.dispose()
  })

  it('shows disconnect refusal without changing routing', async () => {
    const test = setup()
    test.signOut.mockResolvedValueOnce({ ok: false, error: new RemoteError('authorization/rejected', 'busy', { code: 'ALREADY_IN_FLIGHT' }) })
    test.connection.actions.disconnect()
    await idle(test.connection)
    expect(test.connection.store.getSnapshot().failure).toBe('disconnect')
    expect(test.mutate).not.toHaveBeenCalled()
  })

  it('contains unavailable Remote methods and retains an already reported failure', async () => {
    const login = setup()
    login.signIn.mockImplementationOnce(() => { throw new Error('unmounted') })
    login.connection.actions.connect(namespace, false)
    await idle(login.connection)
    expect(login.connection.store.getSnapshot().failure).toBe('signIn')
    const logout = setup()
    logout.signOut.mockRejectedValueOnce(new Error('unmounted'))
    logout.connection.actions.disconnect()
    await idle(logout.connection)
    expect(logout.connection.store.getSnapshot().failure).toBe('disconnect')
    const reload = setup()
    reload.load.mockRejectedValueOnce(new Error('unavailable'))
    reload.connection.actions.connect(namespace, true)
    await idle(reload.connection)
    expect(reload.connection.store.getSnapshot().failure).toBe('settings')
    const failed = setup()
    failed.discover.mockResolvedValueOnce({ ok: true, value: [] })
    failed.load.mockRejectedValueOnce(new Error('unavailable'))
    failed.connection.actions.connect(namespace, true)
    await idle(failed.connection)
    expect(failed.connection.store.getSnapshot().failure).toBe('models')
  })

  it.each([false, true])('cancels an outstanding model-list request without applying settings: rejects=%s', async (reject) => {
    const test = setup()
    const pending = Promise.withResolvers<Awaited<ReturnType<Context['remote']['llm']['discoverModels']>>>()
    test.discover.mockImplementationOnce(() => pending.promise)
    test.connection.actions.connect(namespace, true)
    test.connection.actions.cancel()
    if (reject) pending.reject(new Error('aborted'))
    else pending.resolve({ ok: true, value: [{ id: 'gpt-account' }] })
    await idle(test.connection)
    expect(test.mutate).not.toHaveBeenCalled()
    expect(test.connection.store.getSnapshot().failure).toBeNull()
  })

  it('does not activate a grant after the initiating page cancels', async () => {
    const test = setup()
    test.signIn.mockImplementationOnce(() => ({
      ...test.stream,
      async *[Symbol.asyncIterator]() {
        yield { type: 'settled', outcome: { status: 'authorized' } }
        test.connection.actions.cancel()
      },
    }))
    test.connection.actions.connect(namespace, false)
    await idle(test.connection)
    expect(test.discover).not.toHaveBeenCalled()
  })

  it('preserves available model metadata without inventing absent names or capacities', async () => {
    const test = setup()
    test.discover.mockResolvedValueOnce({ ok: true, value: [
      { id: 'unnamed' }, { id: 'known', name: 'Known GPT', contextWindow: 128000, inputModalities: ['text'] },
    ] })
    test.connection.actions.connect(namespace, true)
    await idle(test.connection)
    expect(test.mutate.mock.calls[0]?.[1][1]).toEqual({ op: 'set', path: ['providers', 'openai', 'models'], value: [
      { id: 'unnamed' }, { id: 'known', name: 'Known GPT', contextWindow: 128000, input: ['text'] },
    ] })
  })

  it('disconnects the grant without restoring API-key authentication', async () => {
    const { connection, signOut, mutate } = setup()
    connection.actions.disconnect()
    await idle(connection)
    expect(signOut).toHaveBeenCalledWith('llm-pi-ai', 'openai')
    expect(mutate).not.toHaveBeenCalled()
    expect(providerUsable({ ...row, authorization: { ...row.authorization!, kind: null } })).toBe(false)
    expect(providerUsable(row)).toBe(true)
  })
})

describe('ChatGPT subscription card', () => {
  it('shows connection state and disconnect', () => {
    const { connection } = setup()
    const disconnect = vi.fn()
    render(<ChatGptCard row={row} namespace={namespace} state={connection.store.getSnapshot()}
      actions={{ ...connection.actions, disconnect }} readOnly={false} t={key => en[key]} />)
    expect(screen.getByRole('status').textContent).toBe(en.chatGptConnected)
    fireEvent.click(screen.getByRole('button', { name: en.chatGptDisconnect }))
    expect(disconnect).toHaveBeenCalledOnce()
  })

  it('shows HTTPS browser handoff and masks secret questions', () => {
    const { connection, send } = setup()
    const state = {
      status: 'signing-in' as const,
      notice: { message: 'Approve in browser', url: 'https://auth.openai.com/authorize', code: 'ABCD-1234' },
      prompt: { type: 'prompt' as const, id: promptId, prompt: { kind: 'secret' as const, message: 'One-time code' } },
      failure: null,
    }
    const answer = vi.fn()
    render(<ChatGptCard row={row} namespace={namespace} state={state}
      actions={{ ...connection.actions, answer }} readOnly={false} t={key => en[key]} />)
    expect(screen.getByRole('link', { name: en.chatGptOpen }).getAttribute('href')).toBe('https://auth.openai.com/authorize')
    const input = screen.getByLabelText('One-time code')
    expect(input.getAttribute('type')).toBe('password')
    fireEvent.change(input, { target: { value: 'typed-code' } })
    fireEvent.click(screen.getByRole('button', { name: en.chatGptAnswer }))
    expect(answer).toHaveBeenCalledWith({ id: promptId, value: 'typed-code' })
    expect((input as HTMLInputElement).value).toBe('')
    expect(send).not.toHaveBeenCalled()
  })

  it('keeps a failed connection read visible and disables writes with unknown credential state', () => {
    const { connection } = setup()
    render(<ChatGptCard row={{ ...row, authorization: null, authorizationError: true }} namespace={namespace}
      state={connection.store.getSnapshot()} actions={connection.actions} readOnly={false} t={key => en[key]} />)
    expect(screen.getByRole('alert').textContent).toBe(en.chatGptStatusError)
    expect(screen.getByRole('button', { name: en.chatGptContinue }).hasAttribute('disabled')).toBe(true)
  })

  it.each([
    { subscription: false, kind: null, label: en.chatGptContinue, reuse: false },
    { subscription: true, kind: 'grant', label: en.chatGptReconnect, reuse: false },
    { subscription: false, kind: 'grant', label: en.chatGptFinish, reuse: true },
  ] as const)('starts the chosen connection action: $label', ({ subscription, kind, label, reuse }) => {
    const test = setup()
    const connect = vi.fn()
    render(<ChatGptCard row={{ ...row, subscription, authorization: { ...row.authorization!, kind } }} namespace={namespace}
      state={test.connection.store.getSnapshot()} actions={{ ...test.connection.actions, connect }} readOnly={false} t={key => en[key]} />)
    fireEvent.click(screen.getByRole('button', { name: label }))
    expect(connect).toHaveBeenCalledWith(namespace, reuse)
  })

  it('renders provider choices and sends the selected option', () => {
    const test = setup()
    const answer = vi.fn()
    const state: ChatGptState = { status: 'signing-in', failure: null, notice: null,
      prompt: { type: 'prompt', id: promptId, prompt: { kind: 'select', message: 'Account', options: [
        { id: 'personal', label: 'Personal' }, { id: 'work', label: 'Work' },
      ] } } }
    render(<ChatGptCard row={row} namespace={namespace} state={state}
      actions={{ ...test.connection.actions, answer }} readOnly={false} t={key => en[key]} />)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'work' } })
    fireEvent.click(screen.getByRole('button', { name: en.chatGptAnswer }))
    expect(answer).toHaveBeenCalledWith({ id: promptId, value: 'work' })
  })

  it('keeps an empty provider choice disabled', () => {
    const test = setup()
    const state: ChatGptState = { status: 'signing-in', failure: null, notice: null,
      prompt: { type: 'prompt', id: promptId, prompt: { kind: 'select', message: 'Account', options: [] } } }
    render(<ChatGptCard row={row} namespace={namespace} state={state}
      actions={test.connection.actions} readOnly={false} t={key => en[key]} />)
    expect(screen.getByRole('button', { name: en.chatGptAnswer }).hasAttribute('disabled')).toBe(true)
  })

  it('renders a manual callback field and rejects an invalid notice URL', () => {
    const test = setup()
    const state: ChatGptState = { status: 'signing-in', failure: null, notice: { message: 'Continue', url: 'not a URL' },
      prompt: { type: 'prompt', id: promptId, prompt: { kind: 'text', message: 'Callback URL' } } }
    render(<ChatGptCard row={row} namespace={namespace} state={state}
      actions={test.connection.actions} readOnly={false} t={key => en[key]} />)
    expect(screen.getByLabelText('Callback URL').getAttribute('type')).toBe('text')
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('reports model-list progress and its retryable failure', () => {
    const test = setup()
    render(<ChatGptCard row={{ ...row, subscription: false }} namespace={namespace}
      state={{ ...test.connection.store.getSnapshot(), status: 'saving', failure: 'models' }}
      actions={test.connection.actions} readOnly={false} t={key => en[key]} />)
    expect(screen.getByRole('status').textContent).toBe(en.chatGptSaving)
    expect(screen.getByRole('alert').textContent).toBe(en.chatGptModelsError)
  })

  it('does not make non-HTTPS notices executable', () => {
    const { connection } = setup()
    render(<ChatGptCard row={row} namespace={namespace} state={{ ...connection.store.getSnapshot(), notice: { message: 'Invalid', url: 'javascript:alert(1)' } }}
      actions={connection.actions} readOnly={false} t={key => en[key]} />)
    expect(screen.queryByRole('link')).toBeNull()
  })
})
