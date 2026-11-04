/** Durable, provider-specific host identity for ChatGPT authorization. */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { LlmError } from '@deepseek-ai/dsh-llm'

const DEVICE_KEY = credentialKey('llm-pi-ai-device', 'openai')
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Reject corrupt identity records rather than registering this host again. */
function deviceId(record: CredentialRecord): string {
  if (record.kind === 'grant' && typeof record.payload === 'object' && record.payload !== null) {
    const id: unknown = Reflect.get(record.payload, 'deviceId')
    if (typeof id === 'string' && UUID.test(id)) return id
  }
  throw new LlmError(
    'The stored ChatGPT host ID is invalid. Repair llm-pi-ai-device/openai in the credentials document before signing in.',
    'INVALID_DEVICE_ID',
  )
}

/**
 * Read or atomically create the host UUID, independently of the account grant.
 * Signing out preserves this identity; concurrent processes share one value.
 * @param ctx - plugin context with writable credential storage.
 * @returns this Harness home's stable OpenAI host UUID.
 */
export async function openAiDeviceId(ctx: Context): Promise<string> {
  const credentials = ctx.get('credentials')
  if (credentials === undefined) {
    throw new LlmError('ChatGPT sign-in requires a writable credentials service.', 'NO_CREDENTIAL_STORE')
  }
  const identity: { deviceId: string } = { deviceId: randomUUID() }
  await credentials.modifyRecord(DEVICE_KEY, (current) => {
    if (current !== undefined) {
      identity.deviceId = deviceId(current)
      return Promise.resolve(current)
    }
    return Promise.resolve({ kind: 'grant', payload: identity })
  })
  return identity.deviceId
}
