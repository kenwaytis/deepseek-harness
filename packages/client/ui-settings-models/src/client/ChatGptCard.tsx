/** Native ChatGPT subscription connection and its transient browser interaction. */

import { useState } from 'react'
import type { ReactNode } from 'react'
import type { AuthorizationReply, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import type { ChatGptActions, ChatGptState } from './chatgpt.ts'
import type { ProviderRow } from './store.ts'
import type { ModelsKey } from './locales.ts'
import styles from './ModelsSection.module.css'

/** Subscription controls receive only redacted state and caller-bound actions. */
export interface ChatGptCardProps {
  readonly row: ProviderRow
  readonly namespace: SettingsNamespaceView
  readonly state: ChatGptState
  readonly actions: ChatGptActions
  readonly readOnly: boolean
  readonly t: (key: ModelsKey) => string
}

const failureKeys = {
  signIn: 'chatGptSignInError', models: 'chatGptModelsError', settings: 'chatGptSettingsError', disconnect: 'chatGptDisconnectError',
} as const

/** Accept only external HTTPS pages from an authorization notice. */
function signInUrl(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  try { return new URL(value).protocol === 'https:' ? value : undefined }
  catch (_error) {
    // Invalid notice URLs are never rendered as executable links.
    return undefined
  }
}

/**
 * Render ChatGPT setup without accepting tokens or API keys.
 * @param props - redacted OpenAI row, current interaction, and localized actions.
 * @returns the subscription card.
 */
export function ChatGptCard({ row, namespace, state, actions, readOnly, t }: ChatGptCardProps): ReactNode {
  const busy = state.status !== 'idle'
  const connected = row.subscription === true && row.authorization?.kind === 'grant'
  const disabled = readOnly || row.authorization?.writable !== true || busy
  const url = signInUrl(state.notice?.url)
  return <section className={styles['rowCard']} aria-label={t('chatGptTitle')}>
    <span className={styles['rowName']}>{t('chatGptTitle')}</span>
    <p className={styles['intro']}>{t('chatGptDescription')}</p>
    {connected ? <p className={styles['savedNotice']} role="status">{t('chatGptConnected')}</p> : null}
    <div className={styles['subscriptionActions']}>
      <button type="button" className={styles['primaryButton']} disabled={disabled}
        onClick={() => { actions.connect(namespace, !connected && row.authorization?.kind === 'grant') }}>
        {t(connected ? 'chatGptReconnect' : row.authorization?.kind === 'grant' ? 'chatGptFinish' : 'chatGptContinue')}
      </button>
      {row.authorization?.kind === 'grant' ? <button type="button" className={styles['secondaryButton']}
        disabled={disabled} onClick={actions.disconnect}>{t('chatGptDisconnect')}</button> : null}
      {state.status === 'signing-in' ? <button type="button" className={styles['secondaryButton']}
        onClick={actions.cancel}>{t('cancel')}</button> : null}
    </div>
    {state.status === 'signing-in' || state.status === 'saving' ? <p className={styles['advancedHint']} role="status">{t(state.status === 'signing-in' ? 'chatGptSigningIn' : 'chatGptSaving')}</p> : null}
    {url === undefined ? null : <a className={styles['linkButton']} href={url} target="_blank" rel="noopener noreferrer">{t('chatGptOpen')}</a>}
    {state.notice?.code === undefined ? null : <code>{state.notice.code}</code>}
    {state.prompt === null ? null : <Question key={state.prompt.id} frame={state.prompt} answer={actions.answer} t={t} />}
    {row.authorizationError === true ? <p className={styles['error']} role="alert">{t('chatGptStatusError')}</p> : null}
    {state.failure === null ? null : <p className={styles['error']} role="alert">{t(failureKeys[state.failure])}</p>}
  </section>
}

/** One question owns its draft only until its flow withdraws or replaces it. */
function Question({ frame, answer, t }: {
  frame: NonNullable<ChatGptState['prompt']>
  answer: (reply: AuthorizationReply) => void
  t: ChatGptCardProps['t']
}): ReactNode {
  const { prompt } = frame
  const [value, setValue] = useState(prompt.kind === 'select' ? prompt.options[0]?.id ?? '' : '')
  const [sent, setSent] = useState(false)
  return <form className={styles['field']} onSubmit={(event) => {
    event.preventDefault()
    answer({ id: frame.id, value })
    setValue('')
    setSent(true)
  }}>
    <label className={styles['fieldLabel']} htmlFor={frame.id}>{prompt.message}</label>
    {prompt.kind === 'select'
      ? <select id={frame.id} className={`${styles['input']} ${styles['selectInput']}`} value={value} disabled={sent} onChange={(event) => { setValue(event.target.value) }}>
        {prompt.options.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
      </select>
      : <input id={frame.id} className={styles['input']} type={prompt.kind === 'secret' ? 'password' : 'text'}
        autoComplete="off" value={value} placeholder={prompt.placeholder} disabled={sent}
        onChange={(event) => { setValue(event.target.value) }} />}
    <button type="submit" className={styles['secondaryButton']} disabled={sent || value.trim().length === 0}>{t('chatGptAnswer')}</button>
  </form>
}
