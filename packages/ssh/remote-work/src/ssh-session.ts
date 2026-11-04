/** SSH authentication and server identity verification; no password is written to disk. */
import ssh2, { type AnyAuthMethod, type ClientChannel, type SFTPWrapper } from 'ssh2'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ConnectComputerRequest } from './types.ts'

const { Client, utils } = ssh2

import { cancellationError } from './cancellation.ts'

/** A server identity must be confirmed before authentication and installation. */
export class HostIdentityRequired extends Error {
  /** @param fingerprint - observed SSH SHA-256 identity, not yet trusted. */
  constructor(readonly fingerprint: string) {
    super('Confirm the SSH server fingerprint before connecting')
    this.name = 'HostIdentityRequired'
  }
}

/** One authenticated transport; the remote Runtime has a separate lifetime. */
export class SshSession {
  private readonly client = new Client()
  private readonly lifetime = new AbortController()
  private readonly completion = Promise.withResolvers<void>()
  private state: 'idle' | 'preparing' | 'connecting' | 'open' | 'closed' = 'idle'
  private handshake: Promise<void> | undefined
  private closing: Promise<void> | undefined
  /** Physical transport termination; it never terminates remote work. */
  readonly ended = this.completion.promise

  /**
   * @param request - saved identity and memory-only authentication.
   * @param timeoutMs - SSH handshake deadline.
   * @param keepaliveIntervalMs - interval between SSH liveness probes.
   * @param keepaliveMax - unanswered probes before transport failure.
   */
  constructor(
    private readonly request: ConnectComputerRequest,
    private readonly timeoutMs: number,
    private readonly keepaliveIntervalMs: number,
    private readonly keepaliveMax: number,
  ) {
    this.client.once('close', () => {
      this.state = 'closed'
      this.completion.resolve()
    })
    this.client.on('error', () => {
      /* The handshake or active RPC reports failures; close may emit another ssh2 error. */
    })
  }

  /** Authenticate once, after exact fingerprint verification.
   * @param signal - connection cancellation.
   */
  connect(signal: AbortSignal): Promise<void> {
    if (this.handshake !== undefined || this.state !== 'idle')
      return Promise.reject(new Error('SSH transport cannot be connected twice'))
    this.handshake = this.connectOnce(AbortSignal.any([signal, this.lifetime.signal]))
    return this.handshake
  }

  private async connectOnce(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    this.state = 'preparing'
    const username = this.request.username
    const authHandler: AnyAuthMethod[] = []
    const agent =
      process.env.SSH_AUTH_SOCK ?? (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined)
    if (this.request.identityFile === undefined && agent !== undefined)
      authHandler.push({ type: 'agent', username, agent })
    const candidates =
      this.request.identityFile === undefined
        ? [join(homedir(), '.ssh/id_ed25519'), join(homedir(), '.ssh/id_rsa')]
        : [this.request.identityFile]
    for (const file of candidates) {
      let bytes: Buffer
      try {
        bytes = await readFile(file, { signal })
      } catch (error) {
        if (
          this.request.identityFile !== undefined ||
          !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
        )
          throw error
        continue
      }
      const keys = utils.parseKey(bytes)
      if (keys instanceof Error) {
        if (this.request.identityFile !== undefined)
          throw new Error(`Cannot read SSH private key ${file}; use an unlocked SSH agent for encrypted keys`, {
            cause: keys,
          })
        continue
      }
      for (const key of [keys].flat()) authHandler.push({ type: 'publickey', username, key })
    }
    if (this.request.password !== undefined)
      authHandler.push({ type: 'password', username, password: this.request.password })
    signal.throwIfAborted()
    await new Promise<void>((resolve, reject) => {
      let identityFailure: HostIdentityRequired | undefined
      const cleanup = (): void => {
        this.client.off('ready', ready)
        this.client.off('error', failed)
        this.client.off('close', closed)
        signal.removeEventListener('abort', abort)
      }
      const abort = (): void => {
        cleanup()
        this.client.destroy()
        reject(cancellationError(signal))
      }
      const failed = (error: Error): void => {
        cleanup()
        reject(identityFailure ?? error)
      }
      const closed = (): void => {
        failed(new Error('SSH transport closed before authentication completed'))
      }
      const ready = (): void => {
        cleanup()
        this.state = 'open'
        resolve()
      }
      this.client.once('ready', ready)
      this.client.once('error', failed)
      this.client.once('close', closed)
      signal.addEventListener('abort', abort, { once: true })
      this.state = 'connecting'
      try {
        this.client.connect({
          host: this.request.host,
          port: this.request.port,
          username,
          authHandler,
          readyTimeout: this.timeoutMs,
          keepaliveInterval: this.keepaliveIntervalMs,
          keepaliveCountMax: this.keepaliveMax,
          hostVerifier: (key: Buffer) => {
            const fingerprint = `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/u, '')}`
            if (this.request.fingerprint === fingerprint) return true
            identityFailure = new HostIdentityRequired(fingerprint)
            return false
          },
        })
      } catch (error) {
        // ssh2 rejects invalid connection specifications before acquiring its socket.
        cleanup()
        this.state = 'closed'
        this.client.destroy()
        this.completion.resolve()
        reject(error instanceof Error ? error : new Error('SSH handshake failed', { cause: error }))
      }
    })
  }

  /**
   * Execute an installation command; errors retain bounded SSH diagnostics.
   * @param command - platform-quoted bootstrap command, never model text.
   * @param signal - cancellation before or during execution.
   * @returns stdout after a successful remote exit.
   */
  async exec(command: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    const stream = await new Promise<ClientChannel>((resolve, reject) => {
      this.client.exec(command, (error, channel) => {
        if (error) reject(error)
        else resolve(channel)
      })
    })
    return new Promise<string>((resolve, reject) => {
      let stdout = ''
      let stderr = ''
      let bytes = 0
      const abort = (): void => {
        stream.close()
        reject(cancellationError(signal))
      }
      signal.addEventListener('abort', abort, { once: true })
      const data = (chunk: Buffer, error: boolean): void => {
        bytes += chunk.length
        if (bytes > 256 * 1024) {
          stream.close()
          reject(new Error('SSH installation output exceeded its limit'))
          return
        }
        if (error) stderr += chunk.toString('utf8')
        else stdout += chunk.toString('utf8')
      }
      stream.on('data', (chunk: Buffer) => {
        data(chunk, false)
      })
      stream.stderr.on('data', (chunk: Buffer) => {
        data(chunk, true)
      })
      stream.once('error', reject)
      stream.once('close', (code: number | undefined) => {
        signal.removeEventListener('abort', abort)
        if (code === 0) resolve(stdout.trim())
        else reject(new Error(`Remote installation command failed (${String(code)}): ${stderr.trim().slice(-4096)}`))
      })
      if (signal.aborted) abort()
    })
  }

  /** Open a remote loopback channel.
   * @param port - daemon endpoint.
   * @returns encrypted SSH channel.
   */
  forward(port: number): Promise<ClientChannel> {
    return new Promise((resolve, reject) => {
      this.client.forwardOut('127.0.0.1', 0, '127.0.0.1', port, (error, stream) => {
        if (error) {
          reject(error)
          return
        }
        stream.on('error', () => {
          /* Authentication or the RPC reader reports this physical channel failure. */
        })
        resolve(stream)
      })
    })
  }

  /** Open the SSH file-transfer subsystem.
   * @returns authenticated SFTP client.
   */
  sftp(): Promise<SFTPWrapper> {
    return new Promise((resolve, reject) => {
      this.client.sftp((error, sftp) => {
        if (error) reject(error)
        else resolve(sftp)
      })
    })
  }

  /** Close transport and handshake work without stopping the Runtime; await ssh2 quiescence. */
  close(): Promise<void> {
    return (this.closing ??= this.closeOnce())
  }

  private async closeOnce(): Promise<void> {
    this.lifetime.abort(new Error('SSH transport closed'))
    if (this.state === 'idle' || this.state === 'preparing') {
      this.state = 'closed'
      this.completion.resolve()
    } else if (this.state !== 'closed') this.client.destroy()
    await this.ended
    await this.handshake?.catch(() => {})
  }
}

/**
 * Quote a PowerShell bootstrap with UTF-8 output and no profile or interactive prompts.
 * @param script - trusted bootstrap source with separately quoted interpolated values.
 * @returns an OpenSSH-compatible command for native Windows PowerShell.
 */
export function powershell(script: string): string {
  const source = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); try { ${script} } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`
  return `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(source, 'utf16le').toString('base64')}`
}

/** Quote one literal bootstrap argument.
 * @param value - argument.
 * @returns PowerShell single-quoted literal.
 */
export function psQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}
/** Quote one POSIX bootstrap argument.
 * @param value - argument.
 * @returns shell single-quoted literal.
 */
export function shQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}
