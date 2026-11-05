/** Remote work: local Agents with computer-qualified files, commands and terminals over SSH. */
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { Context, Service } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { defineDomain, domainTable, type KvTable } from '@deepseek-ai/dsh-storage-domain'
import { Remote, RemoteError, principalOf, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Config as LocalFilesystemConfig } from '@deepseek-ai/dsh-fs-sandbox'
import { SandboxBashExecutor } from '@deepseek-ai/dsh-bash-sandbox'
import { SandboxPwshExecutor } from '@deepseek-ai/dsh-pwsh-sandbox'
import { remoteDirectory, remoteDirectoryOf } from '@deepseek-ai/dsh-util-workspace-path'
import type {} from '@deepseek-ai/dsh-working-directory'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-workspace'
import type {
  ComputerId,
  RemoteComputer,
  ComputerState,
  ConnectComputerRequest,
  ConnectComputerResult,
} from './types.ts'
import { SshSession, HostIdentityRequired } from './ssh-session.ts'
import { RemoteConnection } from './connection.ts'
import { createRuntimeIdentity } from './authentication.ts'
import type { InstallConfig } from './install.ts'
import { RemoteFileSystem, RoutedFileSystem } from './filesystem.ts'
import { RemoteSubprocessRuntime } from './subprocess.ts'
import { RemoteSandboxProvider } from './executors.ts'

export type * from './types.ts'

/** Deployment resource limits and local runtime artifacts. */
export interface Config {
  /** Local filesystem options retained by the execution router. */
  readonly localFilesystem?: LocalFilesystemConfig
  /** Local directory containing the built execution payload. */
  readonly runtimeDirectory?: string
  /** Local cache for verified downloads and temporary uploads. */
  readonly cacheDirectory?: string
  /** Exact private Node release installed on the remote computer. */
  readonly nodeVersion?: string
  /** HTTPS base URL serving Node archives and their checksum manifest. */
  readonly nodeDistributionUrl?: string
  /** HTTPS npm registry used for target-specific native dependencies. */
  readonly nativeRegistryUrl?: string
  /** Maximum bytes accepted for one downloaded archive. */
  readonly maxDownloadBytes?: number
  /** Runtime signature-handshake deadline in milliseconds. */
  readonly authenticationTimeoutMs?: number
  /** Maximum simultaneous sockets accepted by one Runtime. */
  readonly maxConnections?: number
  /** Milliseconds allowed to confirm an explicit remote stop. */
  readonly stopTimeoutMs?: number
  /** Default remote command deadline in milliseconds. */
  readonly commandTimeoutMs?: number
  /** Maximum admitted remote command deadline in milliseconds. */
  readonly maxCommandTimeoutMs?: number
  /** Deadline in milliseconds for one SSH and installation attempt. */
  readonly connectTimeoutMs?: number
  /** Milliseconds between failed reconnect attempts. */
  readonly reconnectDelayMs?: number
  /** Milliseconds between SSH liveness probes. */
  readonly keepaliveIntervalMs?: number
  /** Unanswered liveness probes allowed before transport failure. */
  readonly keepaliveMax?: number
  /** Milliseconds allowed for a new daemon to advertise readiness. */
  readonly runtimeStartupTimeoutMs?: number
  /** Milliseconds between remote process-output observations. */
  readonly pollIntervalMs?: number
  /** Maximum bytes in one file window or process-output page. */
  readonly readChunkBytes?: number
  /** Maximum retained process records; completed records can expire. */
  readonly maxProcesses?: number
  /** Retained tail bytes per process output stream. */
  readonly maxOutputBytes?: number
  /** Maximum cached mutation results available for recovery. */
  readonly maxRememberedOperations?: number
  /** Maximum encoded RPC frame bytes, including result metadata. */
  readonly maxFrameBytes?: number
}

type ResolvedConfig = Required<Config>
const computerInput = z
  .object({
    id: z
      .uuid()
      .transform(value => value as ComputerId)
      .optional(),
    name: z.string().trim().min(1).max(120),
    host: z
      .string()
      .min(1)
      .max(253)
      .refine(value => !/[\s\0]/u.test(value)),
    port: z.number().int().min(1).max(65535),
    username: z.string().min(1).max(256),
    identityFile: z.string().optional(),
    password: z.string().optional(),
    fingerprint: z.string().optional(),
  })
  .strict()
const storedComputer = computerInput.omit({ id: true, password: true }).extend({
  fingerprint: z.string(),
  privateKey: z.string().min(1),
  platform: z.enum(['linux', 'win32']).optional(),
  home: z.string().optional(),
})
type StoredComputer = z.infer<typeof storedComputer>
const computerDomain = defineDomain({
  name: 'remote_work',
  version: 1,
  tables: { computers: domainTable<ComputerId, StoredComputer>(storedComputer) },
})

function publicComputer(id: ComputerId, record: StoredComputer): RemoteComputer {
  return {
    id,
    name: record.name,
    host: record.host,
    port: record.port,
    username: record.username,
    fingerprint: record.fingerprint,
    ...(record.identityFile === undefined ? {} : { identityFile: record.identityFile }),
    ...(record.platform === undefined ? {} : { platform: record.platform }),
    ...(record.home === undefined ? {} : { home: record.home }),
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** SSH credentials and computer administration belong to the Host owner. */
    'remote-work/owner-required': Record<string, never>
    /** A stable computer identity cannot be moved to another SSH account or endpoint. */
    'remote-work/identity-conflict': { readonly id: ComputerId }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    remoteWork: RemoteWorkService
  }
  interface Events {
    /** Remote computer registration or transport state committed.
     * @mode emit
     */
    'remote-work/changed'(): void
  }
}

/** Saves computer identities and owns attachments; the remote daemon owns running tasks. */
export class RemoteWorkService extends TypertRemoteService {
  static inject = ['storageDomain', 'agents', 'typert', 'tools', 'systemPrompt', 'sandboxPolicy', 'shell']
  static Config: schema<Config> = schema.object({
    localFilesystem: schema.object({ cwd: schema.string(), diffBasisMaxBytes: schema.natural().min(1) }).default({}),
    runtimeDirectory: schema.string(),
    cacheDirectory: schema.string(),
    nodeVersion: schema.string().default('24.15.0'),
    nodeDistributionUrl: schema.string().default('https://nodejs.org/dist'),
    nativeRegistryUrl: schema.string().default('https://registry.npmjs.org'),
    maxDownloadBytes: schema.natural().default(128 * 1024 * 1024),
    authenticationTimeoutMs: schema.natural().default(10_000),
    maxConnections: schema.natural().default(16),
    stopTimeoutMs: schema.natural().default(30_000),
    commandTimeoutMs: schema.natural().default(60_000),
    maxCommandTimeoutMs: schema.natural().default(600_000),
    keepaliveIntervalMs: schema.natural().default(10_000),
    keepaliveMax: schema.natural().default(3),
    runtimeStartupTimeoutMs: schema.natural().default(30_000),
    connectTimeoutMs: schema.natural().default(300_000),
    reconnectDelayMs: schema.natural().default(2000),
    pollIntervalMs: schema.natural().default(200),
    readChunkBytes: schema.natural().default(64 * 1024),
    maxProcesses: schema.natural().default(128),
    maxOutputBytes: schema.natural().default(8 * 1024 * 1024),
    maxRememberedOperations: schema.natural().default(128),
    maxFrameBytes: schema.natural().default(64 * 1024 * 1024),
  })
  private readonly config: ResolvedConfig
  private readonly ownerContext: Context
  private table!: KvTable<ComputerId, StoredComputer>
  private readonly connections = new Map<ComputerId, RemoteConnection>()
  private readonly probes = new Set<SshSession>()
  private readonly administration = new Map<ComputerId, Promise<void>>()
  private readonly states = new Map<ComputerId, ComputerState>()
  private readonly filesystems = new Map<ComputerId, RemoteFileSystem>()
  private readonly attachments = new Set<() => Promise<void>>()
  private readonly lifecycle = new AbortController()
  private readonly preparedAgents = new WeakMap<Agent, Promise<void>>()
  private currentDirectory: ((agent: Agent) => string) | undefined

  /**
   * @param ctx - local Host context.
   * @param config - deployment limits and artifact locations.
   */
  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'remoteWork', { namespace: 'remoteWork' })
    this.ownerContext = ctx
    if (ctx.shell.sandboxMode === undefined)
      throw new Error('Remote work requires a sandbox-aware Host shell so Session command policy is explicit')
    const parsed = RemoteWorkService.Config(config) as ResolvedConfig
    this.config = {
      ...parsed,
      runtimeDirectory:
        config.runtimeDirectory ??
        (import.meta.url.endsWith('.ts')
          ? fileURLToPath(new URL('../lib/runtime/', import.meta.url))
          : join(dirname(fileURLToPath(import.meta.url)), 'runtime')),
      cacheDirectory: config.cacheDirectory ?? join(homedir(), '.cache/deepseek-harness/remote-work'),
    }
    for (const key of [
      'authenticationTimeoutMs',
      'maxConnections',
      'stopTimeoutMs',
      'commandTimeoutMs',
      'maxCommandTimeoutMs',
      'connectTimeoutMs',
      'reconnectDelayMs',
      'keepaliveIntervalMs',
      'keepaliveMax',
      'runtimeStartupTimeoutMs',
      'pollIntervalMs',
      'readChunkBytes',
      'maxProcesses',
      'maxOutputBytes',
      'maxRememberedOperations',
      'maxFrameBytes',
      'maxDownloadBytes',
    ] as const) {
      if (!Number.isSafeInteger(this.config[key]) || this.config[key] <= 0)
        throw new Error(`remote-work: ${key} must be a positive integer`)
    }
    if (
      this.config.maxFrameBytes < 4096 ||
      this.config.maxFrameBytes > 64 * 1024 * 1024 ||
      this.config.readChunkBytes > 8 * 1024 * 1024 ||
      this.config.readChunkBytes * 6 + 1024 > this.config.maxFrameBytes
    )
      throw new Error(
        'remote-work: readChunkBytes must fit four encoded output streams inside maxFrameBytes (4 KiB–64 MiB)',
      )
    if (!/^\d+\.\d+\.\d+$/u.test(this.config.nodeVersion))
      throw new Error('remote-work: nodeVersion must be an exact release version')
    for (const field of ['nodeDistributionUrl', 'nativeRegistryUrl'] as const) {
      if (new URL(this.config[field]).protocol !== 'https:') throw new Error(`remote-work: ${field} requires HTTPS`)
    }
    ctx.plugin(RoutedFileSystem, this.config.localFilesystem)
    ctx.inject(['workingDirectory'], (scope) => {
      this.currentDirectory = agent => scope.workingDirectory.get(agent.session)
    })
    ctx.on('workspace/resolve-directory', async (path, next) => {
      const location = remoteDirectoryOf(path)
      if (location === undefined) return next()
      await this.connection(location.computerId as ComputerId).connect()
      const fs = this.filesystem(location.computerId as ComputerId)
      const target = await fs.resolve(location.path)
      if ((await fs.stat(target))?.type !== 'directory') throw new Error('Remote workspace directory does not exist')
      return remoteDirectory(location.computerId, fs.processPath(target))
    })
    ctx.on('session-controller/ensure-directory', async (path, next) => {
      const location = remoteDirectoryOf(path)
      if (location === undefined) return next()
      await this.connection(location.computerId as ComputerId).connect()
      const fs = this.filesystem(location.computerId as ComputerId)
      if ((await fs.stat(await fs.resolve(location.path)))?.type !== 'directory')
        throw new Error('Remote project directory is unavailable')
    })
    ctx.on(
      'agent/pre-step',
      async ({ agent, signal }, next) => {
        const connection = this.connectionFor(agent)
        if (connection !== undefined) {
          this.requireNativePreset(agent)
          await connection.request('terminal.environment', {}, z.unknown(), signal, true)
        }
        return next()
      },
      { prepend: true },
    )
    ctx.on('agent/created', async ({ agent }) => {
      await this.prepareAgent(agent)
    })
    ctx.inject(['remoteWork', 'subprocess'], async () => {
      await Promise.all(ctx.agents.list().map(agent => this.prepareAgent(agent)))
    })
  }

  protected async [Service.init](): Promise<void> {
    const domain = await this.ownerContext.storageDomain.open(computerDomain)
    this.ownerContext.effect(
      () => async () => {
        this.lifecycle.abort(new Error('Remote work is shutting down'))
        try {
          await Promise.allSettled([...this.probes].map(probe => probe.close()))
          await Promise.allSettled([...this.connections.values()].map(connection => connection.close()))
          await Promise.allSettled(this.administration.values())
          await Promise.allSettled([...this.attachments].map(close => close()))
          this.attachments.clear()
        } finally {
          await domain.close()
        }
      },
      'remote-work.attachments-and-storage',
    )
    this.table = domain.table('computers')
    for (const [id, record] of this.table.entries())
      this.states.set(id, { computer: publicComputer(id, record), status: 'disconnected' })
    for (const id of this.states.keys()) {
      void this.connection(id).connect().catch((error: unknown) => {
        if (!this.lifecycle.signal.aborted)
          this.ownerContext.logger.warn(`Could not reconnect remote computer ${id} at startup; reconnect from its connection controls`, error)
      })
    }
  }

  /** Read saved computer identities and connection state.
   * @returns snapshots without secrets.
   */
  @Remote
  list(): ComputerState[] {
    this.requireOwner()
    return [...this.states.values()]
  }

  /**
   * Probe, confirm and connect one computer. No authentication or installation precedes fingerprint confirmation.
   * @param request - SSH identity and optional memory-only password.
   * @param signal - connection/install cancellation.
   * @returns a fingerprint requiring confirmation, or the connected durable registration.
   */
  @Remote
  async connectComputer(request: ConnectComputerRequest, signal: AbortSignal): Promise<ConnectComputerResult> {
    this.requireOwner()
    const control = AbortSignal.any([signal, this.lifecycle.signal])
    control.throwIfAborted()
    const parsed = computerInput.parse(request)
    const saved = parsed.id === undefined ? undefined : this.requireComputer(parsed.id)
    if (
      parsed.id !== undefined &&
      saved !== undefined &&
      (saved.host !== parsed.host || saved.port !== parsed.port || saved.username !== parsed.username)
    ) {
      throw new RemoteError(
        'remote-work/identity-conflict',
        'Create a separate computer registration for another SSH account or endpoint',
        { id: parsed.id },
      )
    }
    const fingerprint = parsed.fingerprint ?? saved?.fingerprint
    const probe = new SshSession(
      { ...request, ...(fingerprint === undefined ? {} : { fingerprint }) },
      this.config.connectTimeoutMs,
      this.config.keepaliveIntervalMs,
      this.config.keepaliveMax,
    )
    this.probes.add(probe)
    try {
      await probe.connect(control)
    } catch (error) {
      control.throwIfAborted()
      if (error instanceof HostIdentityRequired) return { kind: 'trust-required', fingerprint: error.fingerprint }
      throw error
    } finally {
      await probe.close()
      this.probes.delete(probe)
    }
    const id = parsed.id ?? (randomUUID() as ComputerId)
    return this.administer(id, async () => {
      control.throwIfAborted()
      const current = this.table.get(id) ?? saved
      const { password: _password, id: _id, ...fields } = parsed
      const record: StoredComputer = {
        ...fields,
        fingerprint: fingerprint as string,
        privateKey:
          current?.privateKey ?? createRuntimeIdentity().privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        ...(current?.platform === undefined ? {} : { platform: current.platform }),
        ...(current?.home === undefined ? {} : { home: current.home }),
      }
      await this.table.put(id, record)
      this.lifecycle.signal.throwIfAborted()
      this.states.set(id, { computer: publicComputer(id, record), status: 'connecting' })
      this.ctx.emit('remote-work/changed')
      let connection = this.connections.get(id)
      if (connection === undefined || connection.closed) {
        connection = this.makeConnection(id, record, parsed.password)
        this.connections.set(id, connection)
      } else
        connection.reconfigure({
          ...publicComputer(id, record),
          ...(parsed.password === undefined ? {} : { password: parsed.password }),
        })
      const hello = await connection.connect()
      this.lifecycle.signal.throwIfAborted()
      const updated = { ...record, platform: hello.platform, home: hello.home }
      await this.table.put(id, updated)
      this.lifecycle.signal.throwIfAborted()
      const computer = publicComputer(id, updated)
      const state = this.states.get(id)
      if (state === undefined) throw new Error('Remote computer state was lost during registration')
      this.states.set(id, { ...state, computer })
      this.ctx.emit('remote-work/changed')
      return { kind: 'connected' as const, computer }
    })
  }

  /** Disconnect local attachments without stopping remote tasks.
   * @param id - saved computer.
   */
  @Remote
  async disconnectComputer(id: ComputerId): Promise<void> {
    this.requireOwner()
    this.requireComputer(id)
    await this.connections.get(id)?.suspend()
  }

  /**
   * Browse remote directories without moving the Agent or the model connection.
   * @param id - saved computer.
   * @param path - absolute remote directory; omission selects that account's home.
   * @param signal - browse cancellation.
   * @returns canonical parent and child directories.
   */
  @Remote
  async browse(
    id: ComputerId,
    path: string | undefined,
    signal: AbortSignal,
  ): Promise<{ path: string; entries: { name: string; path: string }[] }> {
    this.requireOwner()
    const connection = this.connection(id)
    await connection.connect()
    return connection.request(
      'directory.list',
      { path },
      z
        .object({ path: z.string(), entries: z.array(z.object({ name: z.string(), path: z.string() }).strict()) })
        .strict(),
      signal,
      true,
    )
  }

  /** Stream full state after each change, including connection degradation.
   * @param signal - physical stream lifetime.
   * @returns complete computer snapshots.
   */
  @Remote({ mode: 'stream' })
  async *follow(signal: AbortSignal): AsyncIterable<ComputerState[]> {
    this.requireOwner()
    signal = AbortSignal.any([signal, this.lifecycle.signal])
    let wake: (() => void) | undefined
    let dirty = true
    const dispose = this.ctx.on('remote-work/changed', () => {
      dirty = true
      wake?.()
    })
    const abort = (): void => {
      wake?.()
    }
    signal.addEventListener('abort', abort)
    try {
      while (!signal.aborted) {
        if (dirty) {
          dirty = false
          yield this.list()
        }
        await new Promise<void>((resolve) => {
          wake = resolve
          if (dirty || signal.aborted) resolve()
        })
      }
    } finally {
      dispose()
      signal.removeEventListener('abort', abort)
    }
  }

  /** Select an existing computer or lazily reconnect its saved identity.
   * @param id - saved computer.
   * @returns lifecycle-owned attachment.
   */
  connection(id: ComputerId): RemoteConnection {
    this.lifecycle.signal.throwIfAborted()
    let connection = this.connections.get(id)
    if (connection === undefined) {
      connection = this.makeConnection(id, this.requireComputer(id))
      this.connections.set(id, connection)
    }
    return connection
  }

  /** Resolve the initiating Agent's computer.
   * @param agent - initiating Agent, absent for local administration.
   * @returns remote attachment, or undefined for local Sessions.
   */
  connectionFor(agent: Agent | undefined): RemoteConnection | undefined {
    const location = agent?.session.header.cwd === undefined ? undefined : remoteDirectoryOf(agent.session.header.cwd)
    return location === undefined ? undefined : this.connection(location.computerId as ComputerId)
  }

  /** Resolve one computer's filesystem.
   * @param id - saved computer.
   * @returns filesystem owned by this plugin.
   */
  filesystem(id: ComputerId): RemoteFileSystem {
    this.requireComputer(id)
    let fs = this.filesystems.get(id)
    if (fs === undefined) {
      fs = new RemoteFileSystem(this.ownerContext.isolate('fs'), { computerId: id })
      this.filesystems.set(id, fs)
    }
    return fs
  }

  /** Read effective directory when available.
   * @param agent - initiating Agent.
   * @param fallback - remote root before directory services activate.
   * @returns current raw remote path.
   */
  workingDirectory(agent: Agent | undefined, fallback: string): string {
    const cwd = agent === undefined ? fallback : (this.currentDirectory?.(agent) ?? fallback)
    return remoteDirectoryOf(cwd)?.path ?? cwd
  }
  /** Bounded remote output retention per stream. */
  get outputBytes(): number {
    return this.config.maxOutputBytes
  }
  /** Raw bytes per file window or remote process-output page. */
  get transferBytes(): number {
    return this.config.readChunkBytes
  }
  /** Finite deadline for confirming an explicit stop, including local teardown. */
  get stopTimeoutMs(): number {
    return this.config.stopTimeoutMs
  }
  /** Pace transport observations.
   * @param signal - observation cancellation.
   */
  async waitForPoll(signal: AbortSignal): Promise<void> {
    await delay(this.config.pollIntervalMs, undefined, { signal })
  }
  /** Retain local observation cleanup, not remote process ownership.
   * @param close - attachment cleanup awaited at plugin disposal.
   * @returns release when observation settles.
   */
  retainAttachment(close: () => Promise<void>): () => void {
    this.attachments.add(close)
    return () => {
      this.attachments.delete(close)
    }
  }

  private async administer<T>(id: ComputerId, operation: () => Promise<T>): Promise<T> {
    const pending = (this.administration.get(id) ?? Promise.resolve()).then(operation)
    const settled = pending.then(
      () => undefined,
      () => undefined,
    )
    this.administration.set(id, settled)
    try {
      return await pending
    } finally {
      if (this.administration.get(id) === settled) this.administration.delete(id)
    }
  }

  private prepareAgent(agent: Agent): Promise<void> {
    const location = agent.session.header.cwd === undefined ? undefined : remoteDirectoryOf(agent.session.header.cwd)
    if (location === undefined) return Promise.resolve()
    const known = this.preparedAgents.get(agent)
    if (known !== undefined) return known
    this.requireNativePreset(agent)
    const saved = this.requireComputer(location.computerId as ComputerId)
    const platform = this.connections.get(location.computerId as ComputerId)?.platform?.platform ?? saved.platform
    if (platform === undefined)
      return Promise.reject(new Error('Remote computer must be connected before creating its Agent'))
    // The Session keeps this mask even while its remote plugin is unavailable.
    const wrongTool = platform === 'win32' ? 'bash' : 'pwsh'
    const deny = this.ctx.tools.get(wrongTool, agent) === undefined ? [] : [wrongTool]
    if (deny.length > 0) agent.ctx.tools.restrict({ deny })
    const fiber = agent.ctx.plugin({
      name: 'remote-work-agent-execution',
      inject: ['remoteWork', 'tools', 'systemPrompt'],
      apply: async (scope: Context) => {
        const execution = scope.isolate('subprocess').isolate('sandbox').isolate('shell')
        await execution.plugin(RemoteSubprocessRuntime, { computerId: location.computerId as ComputerId })
        await execution.plugin(RemoteSandboxProvider, { computerId: location.computerId as ComputerId })
        const shellConfig = { timeoutMs: this.config.commandTimeoutMs, maxTimeoutMs: this.config.maxCommandTimeoutMs }
        if (platform === 'win32')
          await execution.plugin(SandboxPwshExecutor, { ...shellConfig, pwshPath: 'powershell.exe' })
        else await execution.plugin(SandboxBashExecutor, shellConfig)
        scope.fiber.assertActive()
        agent.ctx.fiber.assertActive()
        scope.effect(() => this.ctx.agents.registerExecutionContext(agent, execution), 'remote-work.execution-context')
        scope.systemPrompt.context({
          name: 'remote-work:computer',
          order: 1,
          required: true,
          interpolate: false,
          text: `Files, commands and terminals run on remote computer ${JSON.stringify(saved.name)} (${platform === 'win32' ? 'Windows' : 'Linux'}). The Agent and model connection run locally. If the connection is interrupted, wait for reconnection; do not repeat an operation whose outcome is unknown.`,
        })
      },
    })
    const dispose = this.ctx.effect(() => () => fiber.dispose(), 'remote-work.agent-execution')
    agent.ctx.effect(() => dispose, 'remote-work.agent-execution-owner')
    const ready = Promise.resolve(fiber).then(() => undefined)
    this.preparedAgents.set(agent, ready)
    return ready
  }

  private requireNativePreset(agent: Agent): void {
    const preset = this.ctx.get('agentPresets')?.presetForSession(agent.session) ?? agent.session.header.agentPreset
    if (preset === 'minimal' || preset === 'ptc')
      throw new Error(
        'Remote work currently requires the standard or Cordis Agent preset; persistent-shell and PTC presets are not supported',
      )
  }

  private requireOwner(): void {
    const principal: { readonly kind: string } | undefined = principalOf(this.ctx.invocation)
    if (principal !== undefined && principal.kind !== 'owner') {
      throw new RemoteError('remote-work/owner-required', 'Only the Host owner may manage SSH computers', {})
    }
  }
  private requireComputer(id: ComputerId): StoredComputer {
    this.lifecycle.signal.throwIfAborted()
    const record = this.table.get(id)
    if (record === undefined)
      throw new Error(
        `Remote computer ${id} is not registered; restore its registration before resuming this workspace`,
      )
    return record
  }
  private makeConnection(id: ComputerId, record: StoredComputer, password?: string): RemoteConnection {
    const install: InstallConfig = this.config
    return new RemoteConnection(
      { ...publicComputer(id, record), ...(password === undefined ? {} : { password }) },
      record.privateKey,
      install,
      this.config.connectTimeoutMs,
      this.config.reconnectDelayMs,
      (status, error) => {
        if (this.lifecycle.signal.aborted) return
        const previous = this.states.get(id)
        if (previous === undefined) return
        this.states.set(id, { computer: previous.computer, status, ...(error === undefined ? {} : { error }) })
        this.ownerContext.emit('remote-work/changed')
      },
    )
  }
}
export default RemoteWorkService
