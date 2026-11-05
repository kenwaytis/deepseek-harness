---
description: "通过 SSH 连接 Linux 和 Windows 电脑，安装私有执行 Runtime，并在传输中断后恢复远端任务。"
kind: "package-reference"
---

# @deepseek-ai/dsh-remote-work

[English](README.md) | 中文

## 概述

操作远端文件夹，同时让 Agent、模型连接、提供方凭据和对话日志留在本机。连接会在远端 SSH 账户下安装私有 Node.js 发行包和执行 Runtime，无需预装 Node.js 或安装系统服务。文件、搜索、命令和终端使用选定的电脑。中断的观察操作等待重连；结果不确定的修改会恢复原结果或报告结果未知，不会再次执行。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

内置 Web 和 Desktop 组合已包含远程工作。在侧栏选择**添加 → 通过 SSH 连接电脑**，填写主机和 SSH 账户，核对 SHA-256 主机指纹，再确认安装。在该电脑下添加远端目录，然后使用标准或 Cordis 预设创建会话。侧栏按电脑、文件夹、会话分级显示。

<a id="prerequisites-and-authentication"></a>
### 前提与认证

目标端需要支持 SSH 命令执行、SFTP，以及到自身回环接口的 TCP 转发。Linux 安装使用标准 Shell、`tar`、`sha256sum` 和 `nohup`；原生 Windows 使用 PowerShell、`tar.exe` 和 OpenSSH。本机 Host 通过 HTTPS 下载 Node 和目标端原生依赖，校验摘要后上传载荷。本机需能访问配置的发行包与注册表 URL。安装前通过独立可信渠道确认指纹。

认证会尝试本机 SSH agent 和可用的默认私钥，或显式指定的 `identityFile`；填写的密码仅保存在内存中。启动时，Host 会在后台对每台已保存的电脑尝试连接一次，不延迟界面启动。尝试失败时保留电脑记录，并在状态点的提示中显示错误；可通过连接管理重试或提供密码。加密私钥需先在 SSH agent 中解锁。密码字段不用于提供私钥口令。已保存的电脑不能改指向其他主机、端口或 SSH 账户，需另建电脑记录。

### 配置

在内置配置档案中覆盖已有的 `remote-work` 条目；自定义组合必须用此路由器替换文件系统提供者，同时保留本机子进程、沙箱策略以及支持沙箱的 Shell 服务。标准和 Cordis 预设同时提供两种原生命令工具，并设置 `nativePlatformOnly: true`。不要替换全局本机子进程提供者：模型适配器、MCP 和其他本机编排仍使用它。

```yaml
- id: remote-work
  config:
    commandTimeoutMs: 60000
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `nodeVersion` | `24.15.0` | 在本机下载的私有 Node 发行版本 |
| `commandTimeoutMs` | `60000` | 远端命令的默认期限，单位毫秒 |
| `maxCommandTimeoutMs` | `600000` | 允许的最大命令期限 |
| `connectTimeoutMs` | `300000` | 单次 SSH 与安装尝试的期限 |
| `maxOutputBytes` | `8388608` | 每个进程输出流保留的字节数 |
| `maxProcesses` | `128` | 进程记录数；已完成的记录可能过期 |
| `maxRememberedOperations` | `128` | 可恢复的修改结果数 |
| `localFilesystem` | `{}` | 路由到本机文件系统的选项 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-remote-work)维护完整字段列表。资源限制作用于某一代 Runtime；重连到正在运行的代际不会重新配置其进程限制。

### 中断与恢复

连接丢失后，Host 重连期间会暂停新的模型步骤和远端观察操作。已有命令与终端进程属于远端 Runtime，不属于 SSH 传输。重连后重新附加其保留的输出和状态。显式命令期限和用户取消仍然有效。断开电脑会暂停附加，直到再次连接或应用重启，不会停止远端任务。

修改操作在发送前获得操作 ID。回包中断后，Host 按该 ID 取回操作结果，不重新提交。结果记录缺失或 Runtime 被替换时报告 `REMOTE_OUTCOME_UNKNOWN`；决定是否重试前，先检查远端文件或进程。终端输入遵循相同规则。输出截断会明确报告，已完成记录的保留量有限。Runtime 重启、远端重启和载荷代际变更都不会保留内存中的任务恢复状态。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

每台已保存电脑在本机存储中拥有经过验证的 SSH 身份和 Host 签名密钥。对新 nonce 的 Ed25519 签名认证双方端点。只上传 Host 的公开授权密钥；守护进程在内存中生成私有身份，并通过经 SSH 读取的端点文件公布公钥。读取远端配置不授予 RPC 权限，被复用的端口也不能冒充守护进程。Runtime 安装在 SSH 用户的数据目录中，由载荷摘要标识代际。Linux 使用 `nohup` 分离 Runtime；Windows 将其启动到 OpenSSH 作业之外。载荷中不运行 Agent 或模型适配器。

带电脑限定的 `dsh-ssh://` 目录标识会话的执行电脑。文件系统路由和逐 Agent 注册的执行上下文选择远端提供者，Agent 上下文则保持本地。远端提供者缺失时直接失败，不回退为本机执行。原生 V4 头部保留这些地址；旧读取器在头部校验时拒绝它们，不会执行会话。已有的原生绝对目录头部无需迁移，仍可读取。

Runtime 拥有进程记录和有界字节流。Host 使用字节偏移分页获取 base64 输出，重连观察操作，并按操作 ID 恢复修改结果。具体实现见[连接监督](src/connection.ts)、[执行路由](src/filesystem.ts)和 [Runtime 所有权](src/runtime-server.ts)。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [工作区界面](../../client/ui-workspace/README.zh.md) — 电脑与文件夹导航。
- [客户端电脑模型](../../client/remote-work/README.zh.md) — 连接状态与管理。
- [SSH 提供者](../ssh/README.zh.md) — 单独组合的 POSIX helper 部署。
- [沙箱策略](../../sandbox/sandbox-policy/README.zh.md) — 写入权限。

-----

<a id="model-experience"></a>
## 模型体验

### 远端电脑运行时上下文

#### 模型看到的内容

必需的上下文说明选定电脑及其原生平台。`{name}` 使用 JSON 引号表示，`{platform}` 为 `Linux` 或 `Windows`；文件、搜索、命令和终端消费者拥有各自的工具声明与结果呈现。

##### 电脑上下文模板

```markdown
Files, commands and terminals run on remote computer {name} ({platform}). The Agent and model connection run locally. If the connection is interrupted, wait for reconnection; do not repeat an operation whose outcome is unknown.
```

#### Token 影响

一个有界段落，与对话长度无关；保存的电脑名称贡献可变文本。

#### KV Cache 影响

上下文在一次 Agent 附加期间保持稳定。恢复 Agent 时重新获取已保存的电脑元数据，可能替换此上下文；未改变的更早请求内容仍按提供方的缓存规则复用。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

执行 Runtime 存在以下限制：

- 已实测 Linux x64 和 Windows x64。ARM64 打包尚未验证。
- 远端会话不支持持久 Shell 的极简预设和 PTC 预设，请使用标准或 Cordis。
- 不提供 SSH 配置别名、跳板主机、交互式多因素提示和自动删除电脑。
- 恢复状态有界且仅驻留内存；切换 Runtime 代际不会迁移运行中的进程或终端状态。
- 远端 SSH 账户及其操作系统属于可信范围；进程内存检查和恶意主机证明不属于本提供者范围。沙箱模式限制写入，不限制一般文件读取。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
