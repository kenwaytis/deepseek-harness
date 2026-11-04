/**
 * Browser-safe failure vocabulary of the configuration surfaces this package
 * serves. The redacted views themselves live with their seam in
 * `@deepseek-ai/dsh-settings/types`, whose Cordis event declarations already
 * register that file for the Client compilation face.
 *
 * @module @deepseek-ai/dsh-api-settings-controller/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { AuthorizationMethod, AuthorizationNotice, AuthorizationOutcome, AuthorizationPrompt } from '@deepseek-ai/dsh-authorization/types'

/** Identity of a question within one authorization stream. */
export type AuthorizationPromptId = Branded<'AuthorizationPromptId'>

/** A neutral authorization question without its process-local cancellation signal. */
export type AuthorizationQuestion =
  | Omit<Extract<AuthorizationPrompt, { kind: 'text' }>, 'signal'>
  | Omit<Extract<AuthorizationPrompt, { kind: 'secret' }>, 'signal'>
  | Omit<Extract<AuthorizationPrompt, { kind: 'select' }>, 'signal'>

/** Display-only state of one registered authorization flow and its credential. */
export interface AuthorizationView {
  readonly methods: readonly AuthorizationMethod[]
  readonly inFlight: boolean
  readonly kind: 'grant' | 'api-key' | null
  readonly writable: boolean
}

/** Transient interaction on a single authenticated Remote stream; never contains tokens. */
export type AuthorizationFrame =
  | { readonly type: 'notice'; readonly notice: AuthorizationNotice }
  | { readonly type: 'prompt'; readonly id: AuthorizationPromptId; readonly prompt: AuthorizationQuestion }
  | { readonly type: 'withdraw'; readonly id: AuthorizationPromptId }
  | { readonly type: 'settled'; readonly outcome: AuthorizationOutcome }
  | { readonly type: 'failed'; readonly code: string }

/** Answer delivered only to the question's originating authorization stream. */
export interface AuthorizationReply {
  readonly id: AuthorizationPromptId
  readonly value: string
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /**
     * Every seam refusal that is not a stale write: an unregistered or malformed
     * namespace, a read-only provider, schema validation, storage.
     */
    'settings/rejected': { readonly ns: string }
    /**
     * The stored revision moved after the caller read it. Its own outcome rather
     * than an invalid request: the caller must re-read and re-apply.
     */
    'settings/conflict': { readonly ns: string; readonly expected: number; readonly actual: number }
    /**
     * The provider refused a valid credential write, for example because the
     * stored document no longer parses. The details name only the reference,
     * never the value.
     */
    'credential/rejected': { readonly ref: string }
    /** Authorization is unavailable, busy, or refused; details contain no credential payload. */
    'authorization/rejected': { readonly code: string }
  }
}

/** Confirmation that the settings document was handed to the native editor. */
export interface SettingsDocumentOpenValue {
  readonly opened: true
}
