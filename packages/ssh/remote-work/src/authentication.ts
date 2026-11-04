/** Bounded mutual signature authentication; the Host authorization key never leaves the local computer. */
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto'
import type { Duplex } from 'node:stream'
import { cancellationError } from './cancellation.ts'

const MAGIC = Buffer.from('DSH2')
const NONCE_BYTES = 32
const SIGNATURE_BYTES = 64

/** An Ed25519 identity; only its public SPKI representation may be persisted remotely. */
export interface RuntimeIdentity {
  readonly privateKey: KeyObject
  readonly publicKey: string
}

/** Create an in-memory signing identity.
 * @returns private key and base64 SPKI public key.
 */
export function createRuntimeIdentity(): RuntimeIdentity {
  const pair = generateKeyPairSync('ed25519')
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  }
}

/** Derive the non-secret installation authorization key.
 * @param privateKey - Host-only PKCS8 PEM.
 * @returns base64 SPKI public key.
 */
export function runtimeAuthorizationKey(privateKey: string): string {
  const key = createPrivateKey(privateKey)
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Runtime authorization requires an Ed25519 key')
  return createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64')
}

/** An endpoint or client cannot demonstrate possession of its expected private key. */
export class RemoteRuntimeIdentityError extends Error {
  /** Stable failure classification; a failed identity check never authorizes reinstallation. */
  readonly code = 'REMOTE_RUNTIME_IDENTITY'
  /** @param cause - invalid key or authentication failure, when available. */
  constructor(cause?: unknown) {
    super('The remote Runtime identity could not be verified; inspect its installation before reconnecting', { cause })
    this.name = 'RemoteRuntimeIdentityError'
  }
}

/** Parse a bounded canonical Ed25519 SPKI key.
 * @param value - base64 public representation.
 * @returns the verified public key.
 */
export function runtimePublicKey(value: string): KeyObject {
  try {
    const bytes = Buffer.from(value, 'base64')
    if (bytes.length > 128 || bytes.toString('base64') !== value) throw new RemoteRuntimeIdentityError()
    const key = createPublicKey({ key: bytes, type: 'spki', format: 'der' })
    if (key.asymmetricKeyType !== 'ed25519') throw new RemoteRuntimeIdentityError()
    return key
  } catch (error) {
    throw new RemoteRuntimeIdentityError(error)
  }
}

function transcript(role: 'client' | 'server', client: Buffer, server: Buffer): Buffer {
  return Buffer.concat([MAGIC, Buffer.from(role), client, server])
}

async function readBytes(stream: Duplex, bytes: number, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted()
  return new Promise<Buffer>((resolve, reject) => {
    const cleanup = (): void => {
      stream.off('readable', read)
      stream.off('error', failed)
      stream.off('close', closed)
      stream.off('end', closed)
      signal.removeEventListener('abort', aborted)
    }
    const failed = (error: Error): void => {
      cleanup()
      reject(error)
    }
    const closed = (): void => {
      failed(new Error('Remote Runtime transport closed during authentication'))
    }
    const aborted = (): void => {
      cleanup()
      reject(cancellationError(signal))
    }
    const read = (): void => {
      try {
        const value: unknown = stream.read(bytes)
        if (value !== null) {
          if (!Buffer.isBuffer(value) || value.length !== bytes) {
            failed(new Error('Invalid Runtime authentication bytes'))
            return
          }
          cleanup()
          resolve(value)
        } else if (stream.destroyed || stream.readableEnded) closed()
      } catch (error) {
        failed(error instanceof Error ? error : new Error(String(error)))
      }
    }
    stream.on('readable', read)
    stream.once('error', failed)
    stream.once('close', closed)
    stream.once('end', closed)
    signal.addEventListener('abort', aborted, { once: true })
    read()
    if (signal.aborted) aborted()
  })
}

async function writeBytes(stream: Duplex, bytes: Buffer, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    const abort = (): void => {
      reject(cancellationError(signal))
    }
    signal.addEventListener('abort', abort, { once: true })
    stream.write(bytes, (error) => {
      signal.removeEventListener('abort', abort)
      if (error === null || error === undefined) resolve()
      else reject(error)
    })
    if (signal.aborted) abort()
  })
}

/**
 * Authenticate a forwarded endpoint using its SSH-read public key, then prove local authorization.
 * @param stream - SSH-forwarded duplex channel with no RPC reader attached.
 * @param privateKey - Host-only authorization key in PKCS8 PEM form.
 * @param expectedServerKey - base64 public key read from the installed endpoint over verified SSH.
 * @param signal - finite authentication deadline and connection lifetime.
 * @returns after mutual authentication; failure destroys the channel.
 */
export async function authenticateRuntimeClient(
  stream: Duplex,
  privateKey: string,
  expectedServerKey: string,
  signal: AbortSignal,
): Promise<void> {
  try {
    const serverKey = runtimePublicKey(expectedServerKey)
    const hostKey = createPrivateKey(privateKey)
    if (hostKey.asymmetricKeyType !== 'ed25519') throw new RemoteRuntimeIdentityError()
    const client = randomBytes(NONCE_BYTES)
    await writeBytes(stream, Buffer.concat([MAGIC, client]), signal)
    const response = await readBytes(stream, NONCE_BYTES + SIGNATURE_BYTES, signal)
    const server = response.subarray(0, NONCE_BYTES)
    if (!verify(null, transcript('server', client, server), serverKey, response.subarray(NONCE_BYTES)))
      throw new RemoteRuntimeIdentityError()
    await writeBytes(stream, sign(null, transcript('client', client, server), hostKey), signal)
    if ((await readBytes(stream, 1, signal))[0] !== 1) throw new RemoteRuntimeIdentityError()
  } catch (error) {
    stream.destroy()
    throw error
  }
}

/**
 * Verify Host authorization before allocating the larger RPC frame budget.
 * @param stream - accepted loopback socket.
 * @param authorizedKey - parsed installation Host public key, not a secret.
 * @param identity - daemon signing key retained only in memory and its public representation.
 * @param signal - finite authentication deadline and daemon lifetime.
 * @returns after mutual authentication; failure destroys the socket.
 */
export async function authenticateRuntimeServer(
  stream: Duplex,
  authorizedKey: KeyObject,
  identity: RuntimeIdentity,
  signal: AbortSignal,
): Promise<void> {
  try {
    const request = await readBytes(stream, MAGIC.length + NONCE_BYTES, signal)
    if (!request.subarray(0, MAGIC.length).equals(MAGIC)) throw new RemoteRuntimeIdentityError()
    const client = request.subarray(MAGIC.length)
    const server = randomBytes(NONCE_BYTES)
    await writeBytes(
      stream,
      Buffer.concat([server, sign(null, transcript('server', client, server), identity.privateKey)]),
      signal,
    )
    const response = await readBytes(stream, SIGNATURE_BYTES, signal)
    if (!verify(null, transcript('client', client, server), authorizedKey, response)) {
      await writeBytes(stream, Buffer.from([0]), signal)
      throw new RemoteRuntimeIdentityError()
    }
    await writeBytes(stream, Buffer.from([1]), signal)
  } catch (error) {
    stream.destroy()
    throw error
  }
}
