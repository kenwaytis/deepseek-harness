---
description: "运行和重新构建本地 Linux x64 AppImage，在替换文件时保留用户数据，并了解系统要求及尚未实测的 NixOS 兼容性。"
---

# Linux AppImage

[English](README.md) | 中文

## 概述

本地无签名 AppImage 包含完整 Desktop 应用、Host、Web UI、Node.js、Python、pnpm 和 Office 资源。运行时不需要源码仓库、语言运行时或构建工具。它不接入自动更新、强制更新服务、签名或发布流程。

## 目录

- [运行](#run)
- [系统要求](#system-requirements)
- [NixOS](#nixos)
- [用户数据与手动升级](#user-data-and-manual-upgrades)
- [从源码构建](#build-from-source)
- [运行时布局与验证](#runtime-layout-and-verification)

<a id="run"></a>

## 运行

将 AppImage 放在源码仓库以外的可写目录中。以下命令假定文件名为 `DeepSeek-Harness.AppImage`：

```sh
chmod +x DeepSeek-Harness.AppImage
./DeepSeek-Harness.AppImage
```

使用普通桌面用户运行，不要使用 root。应用可以离线本地启动；模型请求、账号登录和下载额外插件分别需要对应在线服务。内置 Office 库和本地运行时无需联网安装。

在 Arch Linux 的 GNOME/Wayland 中，保留会话正常的 Wayland 和输入法环境。XWayland 诊断启动请遵循 [GTK/输入法要求](../../README.zh.md#develop)；将其中的源码启动器替换为 AppImage 不会改变这些要求。关闭 Linux 窗口会走正常的任务感知退出流程；需要任务继续运行时请最小化窗口。

<a id="system-requirements"></a>

## 系统要求

使用 x86_64 glibc Linux 桌面，具备正常图形驱动、GTK 3、NSS、ALSA、GBM/DRM 及 X11/Wayland 库。应用包不包含整个 Linux 用户空间，也不替换宿主图形驱动。在打包机上构建的原生插件可能要求该机器的 glibc/libstdc++ 版本；这不是通用的旧发行版兼容构建。Arch Linux 是运行验收目标，其他发行版需要单独验证启动。

直接挂载 AppImage 需要 FUSE 2（`libfuse.so.2`；Arch 包名为 `fuse2`）及可用的 `/dev/fuse`。无法挂载时，可在空的可写目录中解包并运行解包后的启动器：

```sh
./DeepSeek-Harness.AppImage --appimage-extract
./squashfs-root/AppRun
```

内置 Python 中可选且已弃用的 `crypt` 扩展还需要 `libcrypt.so.1`；Desktop 和内置 Office 库不使用它。

Electron 需要可用的非特权用户命名空间及正常系统沙箱权限。FUSE 挂载不能提供由 root 持有的 setuid 沙箱。启动器绝不会添加 `--no-sandbox`；如果 Electron 报告沙箱失败，应修复宿主命名空间或安全策略。不要使用 root 运行 AppImage，也不要禁用 `webSecurity` 或 `contextIsolation`。

<a id="nixos"></a>

## NixOS

NixOS 需要为内置 ELF 可执行文件提供兼容 FHS 的库和动态链接器环境。使用发行版的 [appimage-run](https://wiki.nixos.org/wiki/Appimage) 包装器，不要让应用改用系统 Node 或 Python：

```sh
nix-shell -p appimage-run --run 'appimage-run ./DeepSeek-Harness.AppImage'
```

这是兼容性指导，不是 NixOS 实测结果。包装器的 FHS 环境与沙箱策略必须支持 Electron 和子进程；GPU 驱动、桌面 portal、字体与原生库版本可能需要宿主配置。用户不需要应用构建工具。本地 Arch 验收不包含 NixOS 虚拟机或跨发行版认证。

<a id="user-data-and-manual-upgrades"></a>

## 用户数据与手动升级

Harness 数据默认位于 `~/.dsh`，也可通过 `DSH_HOME` 指定绝对目录。Desktop 插件 Profile、包文件、lockfile 和 patch 位于 `$DSH_HOME/profiles/desktop`；Session、设置和凭据使用共享 Harness 数据存储。Electron 浏览器数据、快捷键和桌面设置使用 `app.getPath('userData')`，通常为 `${XDG_CONFIG_HOME:-$HOME/.config}/@deepseek-ai/dsh-desktop`。替换应用时保留这些私有目录；它们不在 AppImage 挂载中。历史 Session 中的模型请求路径可以描述当次启动的资源，但不是下次启动选择运行时的配置。

正常退出 Desktop，备份用户数据，用新 AppImage 替换旧文件，恢复可执行权限后启动。不要把数据复制到 `squashfs-root`、AppImage 临时挂载或 `resources`。确认新构建成功启动前，保留旧文件。替换可执行文件不负责迁移或回退已存储的 Session 格式；旧程序可能无法读取新版本写入的数据。Linux 不会把临时 AppImage 挂载路径注册为持久 CLI（命令行界面）命令。

<a id="build-from-source"></a>

## 从源码构建

构建者需要仓库锁定的依赖、Node/pnpm、Git、tar 和原生插件编译工具；终端用户不需要。在 Linux x64 的仓库根目录运行：

```sh
pnpm run package:desktop:linux:x64:appimage
```

命令先构建仓库，准备锁定的 Electron 与 Primary Runtime，生成生产包，组装 `linux-unpacked`，校验归档并运行原生模块、Host 和 Office Smoke，再用锁定的 electron-builder 打包已验证目录。任一阶段失败立即停止，绝不上传产物。未缓存的构建输入需要联网；每次重新解析生产依赖仍有共享 Desktop 流程现有的可复现性限制。

生产安装明确禁用 `ssh2` 和 `cpu-features` 的可选原生构建脚本。SSH 使用依赖支持的 Node 实现，不依赖这些加速器；其他依赖脚本仍逐项保留允许或拒绝决定。

产物为 `apps/desktop/.desktop-build/targets/linux-x64/unsigned-artifacts/deepseek-harness-<version>-linux-x86_64-unsigned.AppImage`。`--check` 只检查配置和工具，不构建；`pnpm run package:desktop:linux:x64:dir` 则停在可运行目录。两者都忽略发布 dotenv 文件及继承的签名/更新设置。版本默认来自产品 manifest（元数据清单）；`--build-version` 接受既有 Desktop 构建版本格式。包内 manifest 记录 `dshBuildCommit` 和 `dshBuildDirty`；阶段日志保留在 `.desktop-build/packaging-runs/`。

<a id="runtime-layout-and-verification"></a>

## 运行时布局与验证

Electron 主进程与 Preload 代码仍在 `resources/app.asar`。普通 Node 无法读取 ASAR，因此 Linux 将完整只读 Host 依赖解包至 `resources/app.asar.unpacked/dsh`；原生插件、ripgrep、Office 引擎和 WASM 都有真实文件路径。`resources/runtime/primary-runtime/dependencies` 包含独立 Node、Python 和 pnpm，`runtime/office-skills` 则包含 skill（技能）。所有应用路径都从当前资源目录解析，不依赖源码仓库或固定挂载路径。Linux Host 和包操作使用内置 Node，避开 Electron 的 GLib/Sharp 冲突；macOS 和 Windows 继续使用 Electron Node 模式。

自定义 `AppRun` 直接执行 Electron，不使用 builder 自动关闭沙箱的回退行为。运行时清单校验文件哈希、成员和可执行权限，归档校验也检查解包副本。Smoke 覆盖离线插件安装/卸载、Sharp、node-pty、搜索、内置 Python、真实 Office 转换与 Host 关闭。完整验收还需要移动最终 AppImage 到仓库外启动，检查真实 GUI、模型、工具和上传路径，使用同一数据重启，并观察子进程和端口清理。打包成功本身不能证明这些交互结果。
