# SSH

English | [中文](ssh.zh.md)

The [SSH provider family](../../packages/ssh/README.md) separates execution computers from the local Harness, model transport, and Session storage. The explicitly deployed POSIX helper owns the connection APIs below; [remote work](../../packages/ssh/remote-work/README.md) adds provisioned Linux/Windows computers and reconnectable per-Session execution. They share filesystem, subprocess, and sandbox interfaces without adding SSH-specific model tools.

## Execution coordinates

Filesystem identities, executable lookup, process cwd, sandbox workspace roots and language-server file URLs refer to the SSH host. Providers canonicalize paths where the files exist, preserving filesystem interpretation of `symlink/..`. The policy resolver carries absolute execution-world spelling without trying to resolve remote paths on the Harness host.

`processPath()` supplies a path usable by the paired subprocess provider. `processPathFromHostPath()` remains unavailable for SSH; installing a remote artifact does not make an arbitrary host path portable. [`NodePtcRuntime`](../../packages/ptc-runtime/ptc-runtime-node/README.md) therefore takes the verified remote launch configuration: an installed script bootstrap or the [helper executable’s embedded worker](../../packages/ssh/ssh-helper-runtime/README.md).

## Transport and trust

Administrative RPC uses the helper’s SSH exec streams. Ordinary stdin, stdout, stderr, terminal output and optional fd 7 control traffic use separately authenticated forwarded Unix sockets. Each forwarded stream has its own SSH channel window; paused program output does not share the control or administrative window. All channels still share connection bandwidth and transport failure.

Deployment authentication, installed artifact verification and per-stream TLS authentication belong to [`dsh-ssh`](../../packages/ssh/ssh/README.md). The helper executes filesystem and process requests with trusted local providers on the remote machine. SSH is a transport; the selected remote sandbox provider enforces file effects.

## Process lifetime and cancellation

A process is reserved before its streams are connected, and launch is accepted at most once. `done` reports the direct result; `waitForExit` observes the remote managed range. Terminal operations retain the asynchronous shared API. Preparation cancellation, launched-process termination and provider disposal release their owned resources through the helper.

Administrative deadlines bound individual RPC observations; they do not replace the execution deadline chosen by a Bash or ptc-runtime consumer. Remote waits can remain pending while other requests progress. SSH loss invalidates pending operations; helper EOF, signals and lease expiry start remote cleanup. The client reports unconfirmed outcomes honestly and never reconnects to replay a possibly executed action.

## Composition scope

Headless records and checks Session cwd through the mounted filesystem provider. Remote FS, Bash, terminal, LSP and PTC consumers can therefore share those coordinates. Web workspace views that assume host filesystem access need separate integration; replacing providers alone does not make those views remote-aware.

See the [decision record](../../.agents/notes/implemented/architecture/2026-09-11-posix-ssh-runtime.md) for the alternatives and verification obligations.

## Remote computers

Remote work stores computer identity separately from workspace and Session identity. A computer-qualified directory keeps their association while file and command paths remain native to the execution computer. The Host owns authentication and connection supervision; the browser observes complete computer snapshots without credentials or signing keys. The [remote-work reference](../../packages/ssh/remote-work/README.md) owns provisioning and recovery limits; the preceding transport and lease semantics describe the separately deployed POSIX helper.

```ts type-equiv
/** Stable identity of one saved SSH computer. */
type ComputerId = Branded<'ComputerId'>
```

```ts type-equiv
/** One saved computer; passwords and runtime capabilities are never projected. */
interface RemoteComputer {
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
```

```ts type-equiv
/** Observable transport state; disconnected does not imply stopped remote processes. */
interface ComputerState {
  readonly computer: RemoteComputer
  readonly status: 'disconnected' | 'connecting' | 'installing' | 'connected' | 'reconnecting' | 'error'
  readonly error?: string
}
```

```ts type-equiv
/** Connection request; passwords live only in memory for this Host lifetime. */
interface ConnectComputerRequest {
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
```

```ts type-equiv
/** A probe requires confirmation before authentication or remote installation. */
type ConnectComputerResult =
  | { readonly kind: 'trust-required'; readonly fingerprint: string }
  | { readonly kind: 'connected'; readonly computer: RemoteComputer }
```

The Client replaces its observable list from these full Host snapshots; access revocation clears it.

```ts type-equiv
/** One full Host-authoritative computer projection. */
interface ComputerSnapshot {
  readonly items: readonly ComputerState[]
  readonly phase: 'loading' | 'ready' | 'error'
  readonly error?: string
}
```

## Connection API

```ts type-equiv
/** Installed helper invocation; script deployments may also install a PTC bootstrap. */
type HelperLaunch = {
  /** Run the installed script with a separately installed Node executable. */
  kind: 'node-script'
  /** Absolute remote Node executable. */
  node: string
  /** Absolute remote PTC bootstrap; requires bootstrapHash. */
  bootstrapPath?: string
  /** Lowercase SHA-256 of bootstrapPath; requires that path. */
  bootstrapHash?: string
} | {
  /** Run the helper executable with its embedded Node and PTC worker. */
  kind: 'executable'
}
```

```ts type-equiv
/** Deployment-owned SSH identity and installed helper; no model argument selects these values. */
interface Config {
  /** OpenSSH host alias, including its existing user, key and known-host configuration. */
  host: string
  /** Explicit script or self-contained executable invocation. */
  launch: HelperLaunch
  /** Absolute path to the installed, bundled helper entry. */
  helper: string
  /** SHA-256 of that bundled helper; mismatches refuse the connection. */
  helperHash: string
  /** Absolute remote default workspace. */
  workspace: string
  /** Connection and administrative-request deadline, at most 2,147,483,647 milliseconds. */
  requestTimeoutMs?: number
  /** Maximum JSON payload bytes per helper request or response. */
  maxFrameBytes?: number
  /** Maximum ordinary requests; heartbeat and bounded resource cleanup have reserved capacity. */
  maxPending?: number
  /** Remote helper lease; loss of heartbeats starts remote managed cleanup. */
  leaseMs?: number
}
```

```ts public-api
/** One non-reconnecting SSH session; loss invalidates all active operations. */
declare class SshConnection extends Service {
  static Config: schema<Config>;
  /** Verified remote helper coordinates; callers must await this before launch. */
  readonly ready: Promise<Hello>;
  constructor(ctx: Context, config: Config);
  /** Hold plugin readiness until the remote identity and helper digest are verified. */
  async [Service.init](): Promise<void>;
  /** Verified remote PTC launch configuration; script deployments require a verified bootstrap. */
  get ptcLaunch(): { kind: 'embedded'; executable: string } | { kind: 'node-script'; executable: string; bootstrapPath: string };
  /**
     * Send a helper operation; cancellation never replays an ambiguous mutation.
     * @param method - the private helper operation.
     * @param params - JSON request fields validated by the helper.
     * @param result - response validation before returning provider-visible data.
     * @param signal - cancellation, which does not undo completed remote effects.
     * @param wait - allow a process observation to outlast the administrative deadline.
     * @returns the validated remote result.
     */
  async request<T>(method: string, params: unknown, result: z.ZodType<T>, signal?: AbortSignal, wait: boolean = false): Promise<T>;
  /**
     * Forward one authenticated stream through an independent SSH channel.
     * @param endpoint - private coordinates issued by this connection's helper.
     * @param signal - cancellation of allocation and the resulting socket.
     * @returns a paused socket; attach a consumer before resuming it.
     */
  async connectStream(endpoint: SshStreamEndpoint, signal?: AbortSignal): Promise<Socket>;
  /** Tear down the helper's remote managed ranges before releasing the SSH master when reachable. */
  dispose(): Promise<void>;
}
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxremotework--remoteworkservice"></a>

### `ctx.remoteWork` — `RemoteWorkService`

Saves computer identities and owns attachments; the remote daemon owns running tasks.

```ts cordis-catalog
/** Read saved computer identities and connection state.
 * @returns snapshots without secrets.
 */
@Remote list(): ComputerState[]

/**
 * Probe, confirm and connect one computer. No authentication or installation precedes fingerprint confirmation.
 * @param request - SSH identity and optional memory-only password.
 * @param signal - connection/install cancellation.
 * @returns a fingerprint requiring confirmation, or the connected durable registration.
 */
@Remote async connectComputer(request: ConnectComputerRequest, signal: AbortSignal): Promise<ConnectComputerResult>

/** Disconnect local attachments without stopping remote tasks.
 * @param id - saved computer.
 */
@Remote async disconnectComputer(id: ComputerId): Promise<void>

/**
 * Browse remote directories without moving the Agent or the model connection.
 * @param id - saved computer.
 * @param path - absolute remote directory; omission selects that account's home.
 * @param signal - browse cancellation.
 * @returns canonical parent and child directories.
 */
@Remote async browse( id: ComputerId, path: string | undefined, signal: AbortSignal, ): Promise<{ path: string; entries: { name: string; path: string }[] }>

/** Stream full state after each change, including connection degradation.
 * @param signal - physical stream lifetime.
 * @returns complete computer snapshots.
 */
@Remote({ mode: 'stream' }) async *follow(signal: AbortSignal): AsyncIterable<ComputerState[]>

/** Select an existing computer or lazily reconnect its saved identity.
 * @param id - saved computer.
 * @returns lifecycle-owned attachment.
 */
connection(id: ComputerId): RemoteConnection

/** Resolve the initiating Agent's computer.
 * @param agent - initiating Agent, absent for local administration.
 * @returns remote attachment, or undefined for local Sessions.
 */
connectionFor(agent: Agent | undefined): RemoteConnection | undefined

/** Resolve one computer's filesystem.
 * @param id - saved computer.
 * @returns filesystem owned by this plugin.
 */
filesystem(id: ComputerId): RemoteFileSystem

/** Read effective directory when available.
 * @param agent - initiating Agent.
 * @param fallback - remote root before directory services activate.
 * @returns current raw remote path.
 */
workingDirectory(agent: Agent | undefined, fallback: string): string

/** Pace transport observations.
 * @param signal - observation cancellation.
 */
async waitForPoll(signal: AbortSignal): Promise<void>

/** Retain local observation cleanup, not remote process ownership.
 * @param close - attachment cleanup awaited at plugin disposal.
 * @returns release when observation settles.
 */
retainAttachment(close: () => Promise<void>): () => void
```

Types: [Agent](core.md)

Source: [`packages/ssh/remote-work/src/index.ts`](../../packages/ssh/remote-work/src/index.ts)

<a id="ctxssh--sshconnection"></a>

### `ctx.ssh` — `SshConnection`

One non-reconnecting SSH session; loss invalidates all active operations.

```ts cordis-catalog
/**
 * Send a helper operation; cancellation never replays an ambiguous mutation.
 * @param method - the private helper operation.
 * @param params - JSON request fields validated by the helper.
 * @param result - response validation before returning provider-visible data.
 * @param signal - cancellation, which does not undo completed remote effects.
 * @param wait - allow a process observation to outlast the administrative deadline.
 * @returns the validated remote result.
 */
async request<T>(method: string, params: unknown, result: z.ZodType<T>, signal?: AbortSignal, wait: boolean = false): Promise<T>

/**
 * Forward one authenticated stream through an independent SSH channel.
 * @param endpoint - private coordinates issued by this connection's helper.
 * @param signal - cancellation of allocation and the resulting socket.
 * @returns a paused socket; attach a consumer before resuming it.
 */
async connectStream(endpoint: SshStreamEndpoint, signal?: AbortSignal): Promise<Socket>

/** Tear down the helper's remote managed ranges before releasing the SSH master when reachable. */
dispose(): Promise<void>
```

Source: [`packages/ssh/ssh/src/index.ts`](../../packages/ssh/ssh/src/index.ts)

<a id="remote-work-events"></a>

### `remote-work/*` events

<a id="remote-workchanged--emit"></a>

#### `remote-work/changed` — emit

Remote computer registration or transport state committed.

```ts cordis-catalog
/** Remote computer registration or transport state committed.
 * @mode emit
 */
'remote-work/changed'(): void
```

Source: [`packages/ssh/remote-work/src/index.ts`](../../packages/ssh/remote-work/src/index.ts)
<!-- END GENERATED cordis-surface -->
