---
kind: upgrade-guide
description: "Web and Desktop profiles route files through remote work and replace flat or nested folder browsing with computer grouping."
---

# Remote-work profile composition

English | [中文](guide.zh.md)

## Change

Web and Desktop profiles use the `remote-work` filesystem router instead of the `fs-sandbox` row. Local Agent, model, MCP, and Session persistence services remain local. Both native shell tools load in the standard and Cordis presets; per-Session platform admission selects Bash or PowerShell.

The sidebar always shows computer → folder → Session while remote work is composed. Saved flat and nested-folder preferences do not control that view. Existing local Workspaces and Session logs need no migration. New remote Sessions use computer-qualified execution URIs; older builds refuse those headers rather than running them locally.

## Migration

1. For unchanged shipped profiles, no configuration or data conversion is required. Local folders appear under **This computer**.
2. If an overlay configures `fs-sandbox`, move filesystem options such as `cwd` and `diffBasisMaxBytes` to `remote-work.config.localFilesystem`. Keep sandbox permissions on `sandbox-policy` and keep local subprocess providers for local orchestration. The [package reference](../../../../packages/ssh/remote-work/README.md) owns configuration and recovery limits.
3. Custom per-Session presets that support both computers must compose `dsh-tool-bash` and `dsh-tool-pwsh` with `nativePlatformOnly: true`. Remote Sessions require standard or Cordis; minimal and PTC remain local-only.
4. Confirm the sidebar's computer group, create a Session under its folder, and verify that the command uses that computer's native shell. Keep a remote Session on a build with remote-work support; disabling its provider does not convert it to a local Session.
