---
description: "Run and rebuild the local Linux x64 AppImage, preserve user data when replacing it, and identify system requirements and unverified NixOS compatibility."
---

# Linux AppImage

English | [中文](README.zh.md)

## Summary

The local unsigned AppImage carries the complete Desktop application, Host, Web UI, Node.js, Python, pnpm and Office resources. Running it requires neither a source checkout nor language runtimes or build tools. It has no automatic updates, mandatory-update service, signing or publication integration.

## Table of Contents

- [Run](#run)
- [System requirements](#system-requirements)
- [NixOS](#nixos)
- [User data and manual upgrades](#user-data-and-manual-upgrades)
- [Build from source](#build-from-source)
- [Runtime layout and verification](#runtime-layout-and-verification)

<a id="run"></a>

## Run

Keep the AppImage in a writable directory outside the source checkout. For the commands below, name the file `DeepSeek-Harness.AppImage`:

```sh
chmod +x DeepSeek-Harness.AppImage
./DeepSeek-Harness.AppImage
```

Run as your ordinary desktop user, not root. The application starts locally without network access; model requests, account sign-in and downloading additional plugins require their respective online services. Bundled Office libraries and the local runtime do not require an installation download.

On Arch Linux with GNOME/Wayland, retain the session's normal Wayland and input-method environment. For an XWayland diagnostic launch, follow the [GTK/input-method requirements](../../README.md#develop); replacing the source launcher there with this AppImage does not change those requirements. Closing the Linux window uses the ordinary task-aware quit; minimize it to keep tasks running.

<a id="system-requirements"></a>

## System requirements

Use an x86_64 glibc Linux desktop with working graphics drivers, GTK 3, NSS, ALSA, GBM/DRM and X11/Wayland libraries. The package does not include a Linux user space or replace the host's graphics drivers. Native addons built on the packaging machine can require its glibc/libstdc++ versions; this is not a universal old-distribution build. Arch Linux is the runtime verification target; other distributions need their own launch checks.

Direct AppImage mounting requires FUSE 2 (`libfuse.so.2`; Arch package `fuse2`) and a usable `/dev/fuse`. If mounting is unavailable, extract to an empty writable directory and run the extracted launcher instead:

```sh
./DeepSeek-Harness.AppImage --appimage-extract
./squashfs-root/AppRun
```

The bundled Python's optional, deprecated `crypt` extension additionally needs `libcrypt.so.1`; Desktop and the bundled Office libraries do not use it.

Electron requires working unprivileged user namespaces and the system's normal sandbox permissions. A FUSE mount cannot provide a root-owned setuid sandbox. The launcher never adds `--no-sandbox`; fix the host namespace or security policy if Electron reports a sandbox failure. Do not run the AppImage as root or disable `webSecurity` or `contextIsolation`.

<a id="nixos"></a>

## NixOS

NixOS needs an FHS-compatible library and dynamic-linker environment for the bundled ELF executables. Use the distribution's [appimage-run](https://wiki.nixos.org/wiki/Appimage) wrapper rather than pointing the application at system Node or Python:

```sh
nix-shell -p appimage-run --run 'appimage-run ./DeepSeek-Harness.AppImage'
```

This is compatibility guidance, not a NixOS test result. The wrapper's FHS environment and sandbox policy must support Electron and child processes; GPU drivers, desktop portals, fonts and native library versions can need host configuration. Application build tools are not required. No NixOS virtual machine or cross-distribution certification is part of local Arch qualification.

<a id="user-data-and-manual-upgrades"></a>

## User data and manual upgrades

Harness data defaults to `~/.dsh`, or the absolute directory selected by `DSH_HOME`. The Desktop plugin profile, its package files, lockfile and patch live in `$DSH_HOME/profiles/desktop`; Sessions, settings and credentials use the shared Harness data stores. Electron browser data, shortcuts and desktop settings use `app.getPath('userData')`, normally `${XDG_CONFIG_HOME:-$HOME/.config}/@deepseek-ai/dsh-desktop`. Keep these private directories when replacing the application; they are not inside the AppImage mount. Model-request paths in historical Sessions can describe that launch's resources; they are not configuration selecting the next runtime.

Quit Desktop normally, back up user data, replace the old AppImage with the new one, restore its executable bit, and start it. Do not copy data into `squashfs-root`, the AppImage's temporary mount, or `resources`. Keep the previous file until the new build starts successfully. Replacing the executable does not migrate or roll back stored Session formats; older executables may not read data written by newer versions. Linux does not register a persistent CLI command pointing into a temporary AppImage mount.

<a id="build-from-source"></a>

## Build from source

Builders need the repository's locked dependencies, Node/pnpm, Git, tar and native-addon compiler tools; end users do not. From the repository root on Linux x64, use:

```sh
pnpm run package:desktop:linux:x64:appimage
```

The command builds the repository, prepares the pinned Electron and primary runtime, materializes production packages, assembles `linux-unpacked`, verifies its archive and runs native/Host/Office smoke checks, then packages that verified directory with the locked electron-builder. It stops on any failed stage and never uploads artifacts. Network access is needed for uncached build inputs; the fresh production dependency resolution retains the shared Desktop pipeline's reproducibility limits.

The output is `apps/desktop/.desktop-build/targets/linux-x64/unsigned-artifacts/deepseek-harness-<version>-linux-x86_64-unsigned.AppImage`. `--check` validates configuration/tooling without building; `pnpm run package:desktop:linux:x64:dir` stops at the runnable directory. Both ignore release dotenv files and inherited signing/update settings. Version defaults to the product manifest; `--build-version` accepts the existing Desktop build-version format. The packaged manifest records `dshBuildCommit` and `dshBuildDirty`; stage logs remain under `.desktop-build/packaging-runs/`.

<a id="runtime-layout-and-verification"></a>

## Runtime layout and verification

Electron main/preload code remains in `resources/app.asar`. Linux unpacks the complete immutable Host graph to `resources/app.asar.unpacked/dsh` because standalone Node cannot read ASAR; native addons, ripgrep, Office engines and WASM therefore have physical paths. `resources/runtime/primary-runtime/dependencies` holds standalone Node, Python and pnpm, while `runtime/office-skills` holds skills. All application paths are resolved from the current resources directory, not a source checkout or fixed mount path. Linux Host and package operations use that bundled Node, avoiding Electron's GLib/Sharp conflict; macOS and Windows keep Electron Node mode.

The custom `AppRun` directly executes Electron without the builder's automatic sandbox-disabling fallback. Runtime inventory checks retain file hashes, membership and executable permissions; archive verification also checks the unpacked copies. Smoke checks exercise offline plugin installation/removal, Sharp, node-pty, search, bundled Python, real Office conversion and Host shutdown. A complete acceptance run additionally moves and launches the final AppImage outside the repository, checks the real GUI/model/tool/upload paths, restarts with the same data, and observes child-process and port cleanup. Successful packaging alone does not establish these interactive results.
