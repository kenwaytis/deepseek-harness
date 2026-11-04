# SSH

[English](ssh.md) | 中文

[SSH 提供者族](../../packages/ssh/README.zh.md)将执行电脑与本机 Harness、模型传输和会话存储分离。显式部署的 POSIX helper 拥有下述连接 API；[远程工作](../../packages/ssh/remote-work/README.zh.md)增加自动部署的 Linux/Windows 电脑及可重连的逐会话执行。两者共享文件系统、子进程和沙箱接口，不新增 SSH 专用模型工具。

## 执行坐标

文件系统身份、可执行文件查找、进程 cwd、沙箱工作区根目录及语言服务器文件 URL 都指向 SSH 主机。提供方在文件实际存在的位置规范化路径，保留文件系统对 `symlink/..` 的解释。策略解析器保留执行环境中的绝对路径写法，不尝试在 Harness 主机上解析远端路径。

`processPath()` 提供配套子进程提供方可用的路径。SSH 的 `processPathFromHostPath()` 仍不可用；安装远端产物不意味着任意主机路径可移植。因此 [`NodePtcRuntime`](../../packages/ptc-runtime/ptc-runtime-node/README.zh.md) 使用验证后的远端启动配置：已安装的脚本引导程序，或 [helper 可执行文件内嵌的 worker](../../packages/ssh/ssh-helper-runtime/README.zh.md)。

## 传输与信任

管理 RPC 使用辅助进程的 SSH exec 流。普通 stdin、stdout、stderr、终端输出及可选 fd 7 控制流使用分别认证的转发 Unix 套接字。每条转发流拥有独立 SSH 通道窗口；暂停的程序输出不与控制或管理消息共用窗口。所有通道仍共享连接带宽及传输失败。

部署认证、已安装产物验证及逐流 TLS 认证属于 [`dsh-ssh`](../../packages/ssh/ssh/README.zh.md)。辅助进程使用远端机器上的可信本地提供方执行文件系统与进程请求。SSH 是传输方式；文件效果限制由所选远端沙箱提供方执行。

## 进程生命周期与取消

进程先预留，再连接流，且启动最多接受一次。`done` 报告直接结果，`waitForExit` 观察远端托管进程范围。终端操作保留共享异步 API。准备阶段取消、已启动进程终止及提供方释放都通过辅助进程释放各自资源。

管理截止时限约束单次 RPC 观察，不替代 Bash 或 PTC 运行时消费方选择的执行截止时限。远端等待可以持续挂起，同时其他请求继续推进。SSH 丢失会使待处理操作失效；辅助进程 EOF、信号及租期到期会启动远端清理。客户端如实报告未确认结果，绝不通过重连重放可能已执行的操作。

## 组合范围

headless 通过已挂载的文件系统提供方记录和检查 Session cwd。因此远端 FS、Bash、终端、LSP 及 PTC 消费方可以共享这些坐标。假定可访问主机文件系统的 Web 工作区视图需要单独集成；仅替换提供方并不会使这些视图支持远端。

替代方案与验证责任见[决策记录](../../.agents/notes/implemented/architecture/2026-09-11-posix-ssh-runtime.zh.md)。

## 远端电脑

远程工作将电脑身份与工作区、会话身份分开存储。带电脑限定的目录保留三者关联，文件和命令路径仍采用执行电脑的原生形式。Host 拥有认证和连接监督，浏览器观察不含凭据或签名密钥的完整电脑快照。[远程工作参考](../../packages/ssh/remote-work/README.zh.md)维护部署与恢复限制；前述传输和租约语义描述单独部署的 POSIX helper。

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

客户端使用这些完整 Host 快照替换可观察列表，权限撤销时清空列表。

```ts type-equiv
/** One full Host-authoritative computer projection. */
interface ComputerSnapshot {
  readonly items: readonly ComputerState[]
  readonly phase: 'loading' | 'ready' | 'error'
  readonly error?: string
}
```

## 连接 API

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

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

Types: [Agent](core.zh.md)

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
