---
description: "Observe SSH computer connection state and submit owner-authorized connection and directory-browsing actions from the browser."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-remote-work

English | [中文](README.zh.md)

## Summary

Show saved SSH computers and their connection state without storing SSH credentials or running SSH in the browser. Workspace surfaces can connect a computer, confirm its fingerprint, disconnect its attachment, and browse remote directories through the Host. Connection snapshots follow Host changes and are cleared when access is revoked.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The shipped Web and Desktop profiles include this package beside the [Host remote-work service](../../ssh/remote-work/README.md). A custom equivalent composition needs the API gateway, generated API remotes, remote access, and Host remote work before adding this Host row:

```yaml
- name: '@deepseek-ai/dsh-client-remote-work'
```

There are no package-specific configuration fields. The [workspace UI](../ui-workspace/README.md) owns dialogs, notices, localization, and computer grouping. The Host owns installation, persistence, SSH authentication, and reconnect supervision.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

A React-free snapshot store replaces its complete computer list from an acknowledged Host stream. Remote access owns the stream lifetime; revocation disposes it and clears state. The Gateway supervises recoverable carrier replacements; an unrecoverable stream failure retains the last list with an error phase. Revocation clears state synchronously, and package disposal joins active and retiring streams. The Host remains authoritative for every computer and connection status.

Commands use the generated `remoteWork` namespace. Password input is passed only to the initiating Host request and is not stored in the snapshot. The public list contains neither the Host signing key nor SSH private-key contents. See the [Client implementation](src/client/index.ts).

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Host remote work](../../ssh/remote-work/README.md) — prerequisites and recovery limits.
- [Workspace UI](../ui-workspace/README.md) — the user-facing computer hierarchy.
- [Remote access](../../api/remote-access/README.md) — permission-scoped Client lifetime.

-----

<a id="model-experience"></a>
## Model Experience

None, as computer snapshots and administration commands are browser state; the Host execution service owns model-facing context.

#### KV Cache effect

This package contributes no model-request content and does not change a reusable model prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Computer administration and directory browsing require owner access; this package does not grant it.
- This package supplies no standalone UI or SSH execution provider.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
