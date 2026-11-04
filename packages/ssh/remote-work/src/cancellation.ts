/** Normalize the untyped Node cancellation reason without replacing an existing Error. */

/** Read one cancellation reason as an Error.
 * @param signal - cancelled operation lifetime.
 * @returns the original Error or an Error retaining a non-Error cause.
 */
export function cancellationError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  return reason instanceof Error ? reason : new Error('Remote operation cancelled', { cause: reason })
}
