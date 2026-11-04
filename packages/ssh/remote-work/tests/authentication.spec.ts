/** Public installation metadata must not grant the authority held by a Host private key. */
import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { cancellationError } from '../src/cancellation.ts'
import {
  createRuntimeIdentity,
  runtimeAuthorizationKey,
  runtimePublicKey,
  RemoteRuntimeIdentityError,
} from '../src/authentication.ts'

describe('Runtime signing keys', () => {
  it('preserves Error cancellation reasons and retains non-Error causes', () => {
    const reason = new Error('cancelled by caller')
    expect(cancellationError(AbortSignal.abort(reason))).toBe(reason)
    expect(cancellationError(AbortSignal.abort('caller cancelled'))).toMatchObject({
      message: 'Remote operation cancelled', cause: 'caller cancelled',
    })
  })

  it('derives only the public authorization key for installation', () => {
    const identity = createRuntimeIdentity()
    const saved = identity.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    expect(runtimeAuthorizationKey(saved)).toBe(identity.publicKey)
    expect(runtimePublicKey(identity.publicKey).type).toBe('public')
    expect(identity.publicKey).not.toContain('PRIVATE KEY')
  })

  it('does not treat readable public metadata as Host signing authority', () => {
    const identity = createRuntimeIdentity()
    expect(() => runtimeAuthorizationKey(identity.publicKey)).toThrow()
    expect(createRuntimeIdentity().publicKey).not.toBe(identity.publicKey)
  })

  it.each(['', 'invalid', Buffer.from('not a public key').toString('base64'), 'A'.repeat(260)])(
    'refuses malformed public-key metadata %s',
    (value) => {
      expect(() => runtimePublicKey(value)).toThrow(RemoteRuntimeIdentityError)
    },
  )

  it('refuses another key algorithm on either side of the signature protocol', () => {
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const publicKey = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
    const privateKey = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    expect(() => runtimePublicKey(publicKey)).toThrow(RemoteRuntimeIdentityError)
    expect(() => runtimeAuthorizationKey(privateKey)).toThrow('Ed25519')
  })
})
