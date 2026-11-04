/** Browser-safe remote computer registration and connection state. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Stable identity of one saved SSH computer. */
export type ComputerId = Branded<'ComputerId'>
/** One saved computer; passwords and runtime capabilities are never projected. */
export interface RemoteComputer {
  readonly id: ComputerId
  readonly name: string
  readonly host: string
  readonly port: number
  readonly username: string
  readonly identityFile?: string
  /** SSH server SHA-256 fingerprint accepted by the operator. */
  readonly fingerprint: string
  readonly platform?: 'linux' | 'win32'
  readonly home?: string
}
/** Observable transport state; disconnected does not imply stopped remote processes. */
export interface ComputerState {
  readonly computer: RemoteComputer
  readonly status: 'disconnected' | 'connecting' | 'installing' | 'connected' | 'reconnecting' | 'error'
  readonly error?: string
}
/** Connection request; passwords live only in memory for this Host lifetime. */
export interface ConnectComputerRequest {
  readonly id?: ComputerId
  readonly name: string
  readonly host: string
  readonly port: number
  readonly username: string
  readonly identityFile?: string
  readonly password?: string
  /** Exact server fingerprint confirmed by the operator; omission probes without installing or authenticating. */
  readonly fingerprint?: string
}
/** A probe requires confirmation before authentication or remote installation. */
export type ConnectComputerResult =
  | { readonly kind: 'trust-required'; readonly fingerprint: string }
  | { readonly kind: 'connected'; readonly computer: RemoteComputer }
