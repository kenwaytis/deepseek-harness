/** Computer-qualified directory identities; the encoded directory belongs to the remote operating system. */

/** A decoded SSH execution location, without credentials or transport options. */
export interface RemoteDirectory {
  /** Stable computer registration UUID. */
  readonly computerId: string
  /** Absolute path on that computer. */
  readonly path: string
}

/**
 * Decode a canonical SSH directory identity. Other paths and malformed identities are not remote directories.
 * @param value - persisted workspace path or Session project identity.
 * @returns the computer and absolute remote path, or undefined.
 */
export function remoteDirectoryOf(value: string): RemoteDirectory | undefined {
  const match = /^dsh-ssh:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/([^/?#]+)$/u.exec(value)
  const computerId = match?.[1]
  const encoded = match?.[2]
  if (computerId === undefined || encoded === undefined) return undefined
  try {
    const path = decodeURIComponent(encoded)
    if (path.includes('\0') || !(path.startsWith('/') || /^[A-Za-z]:[/\\]/u.test(path) || path.startsWith('\\\\')))
      return undefined
    if (encodeURIComponent(path) !== encoded) return undefined
    return { computerId, path }
  } catch (_invalidEscape) {
    return undefined
  }
}

/**
 * Encode an absolute remote path without treating it as a local filesystem path.
 * @param computerId - stable computer UUID.
 * @param path - canonical absolute directory in the remote operating system.
 * @returns the durable computer-qualified directory identity.
 * @throws when either component is invalid.
 */
export function remoteDirectory(computerId: string, path: string): string {
  const value = `dsh-ssh://${computerId}/${encodeURIComponent(path)}`
  if (remoteDirectoryOf(value) === undefined) throw new TypeError('Invalid remote computer or absolute directory')
  return value
}
