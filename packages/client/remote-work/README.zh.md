---
description: "在浏览器中观察 SSH 电脑连接状态，并提交经所有者授权的连接与目录浏览操作。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-remote-work

[English](README.md) | 中文

## 概述

显示已保存的 SSH 电脑及连接状态，不在浏览器中存储 SSH 凭据或运行 SSH。工作区界面可通过 Host 连接电脑、确认指纹、断开附加及浏览远端目录。连接快照跟随 Host 变更，并在访问权限撤销时清空。

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

内置 Web 和 Desktop 配置档案将本包与 [Host 远程工作服务](../../ssh/remote-work/README.zh.md)一起组合。自定义等价组合需要先提供 API gateway、生成的 API remotes、远端访问和 Host 远程工作，再添加以下 Host 条目：

```yaml
- name: '@deepseek-ai/dsh-client-remote-work'
```

本包没有专属配置字段。[工作区界面](../ui-workspace/README.zh.md)负责对话框、提示、本地化和电脑分组。Host 负责安装、持久化、SSH 认证及重连监督。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

不依赖 React 的快照存储使用经过确认的 Host 流整体替换电脑列表。远端访问服务拥有流的生命周期；权限撤销时释放流并清空状态。Gateway 监督可恢复的载体替换；不可恢复的流失败保留最近列表并标记错误阶段。权限撤销同步清空状态，包释放等待活动与正在退出的流结束。每台电脑及连接状态始终以 Host 为准。

命令使用生成的 `remoteWork` 命名空间。密码输入只传给发起的 Host 请求，不存入快照。公开列表不含 Host 签名密钥或 SSH 私钥内容。具体见[客户端实现](src/client/index.ts)。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Host 远程工作](../../ssh/remote-work/README.zh.md) — 前提与恢复限制。
- [工作区界面](../ui-workspace/README.zh.md) — 面向用户的电脑层级。
- [远端访问](../../api/remote-access/README.zh.md) — 按权限限定的客户端生命周期。

-----

<a id="model-experience"></a>
## 模型体验

无，因为电脑快照与管理命令属于浏览器状态；Host 执行服务负责面向模型的上下文。

#### KV Cache 影响

本包不贡献模型请求内容，也不改变可复用的模型前缀。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

- 电脑管理和目录浏览需要所有者权限；本包不授予这些权限。
- 本包不提供独立界面或 SSH 执行提供者。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
