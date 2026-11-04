---
kind: upgrade-guide
description: "Web 和 Desktop 配置档案通过远程工作路由文件，并用电脑分组替代平铺或嵌套文件夹浏览。"
---

# 远程工作的配置档案组合

[English](guide.md) | 中文

## 变更

Web 和 Desktop 配置档案使用 `remote-work` 文件系统路由器代替 `fs-sandbox` 条目。本机 Agent、模型、MCP 和会话持久化服务仍留在本机。标准和 Cordis 预设同时加载两种原生 Shell 工具，由逐会话平台准入选择 Bash 或 PowerShell。

组合远程工作时，侧栏始终显示电脑 → 文件夹 → 会话。保存的平铺和嵌套文件夹偏好不控制此视图。已有本机工作区和会话日志无需迁移。新的远端会话使用带电脑限定的执行 URI；旧构建拒绝这些头部，不会改为本机执行。

## 迁移

1. 未修改的内置配置档案无需配置或数据转换。本机文件夹显示在**本机**分组下。
2. 若覆盖层配置了 `fs-sandbox`，将 `cwd`、`diffBasisMaxBytes` 等文件系统选项移至 `remote-work.config.localFilesystem`。沙箱权限仍配置在 `sandbox-policy`，并保留供本机编排使用的本机子进程提供者。[包参考](../../../../packages/ssh/remote-work/README.zh.md)维护配置与恢复限制。
3. 支持两类电脑的自定义逐会话预设，需同时组合 `dsh-tool-bash` 和 `dsh-tool-pwsh`，并设置 `nativePlatformOnly: true`。远端会话需要标准或 Cordis；极简与 PTC 仍仅供本机使用。
4. 确认侧栏中的电脑分组，在其文件夹下创建会话，并验证命令使用该电脑的原生 Shell。远端会话需继续使用支持远程工作的构建；禁用其提供者不会将它转换成本机会话。
