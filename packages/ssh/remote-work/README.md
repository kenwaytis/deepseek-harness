---
description: "Connect Linux and Windows computers over SSH, install a private execution Runtime, and recover remote tasks after transport interruption."
kind: "package-reference"
---

# @deepseek-ai/dsh-remote-work

English | [中文](README.zh.md)

## Summary

Work on remote folders while the Agent, model connection, provider credentials, and conversation logs stay on your computer. The connection installs a private Node.js distribution and execution Runtime under the remote SSH account; no preinstalled Node.js or system service is required. Files, search, commands, and terminals use the selected computer. Interrupted observations wait for reconnection; uncertain changes recover their original result or report an unknown outcome instead of running again.

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

The shipped Web and Desktop compositions include remote work. In the sidebar, choose **Add → Connect computer over SSH**, enter the host and SSH account, verify its SHA-256 host fingerprint, and confirm installation. Add a remote directory under that computer, then create a Session with the standard or Cordis preset. The sidebar groups computers, folders, and Sessions separately.

<a id="prerequisites-and-authentication"></a>
### Prerequisites and authentication

The target needs SSH command execution, SFTP, and TCP forwarding to its own loopback interface. Linux installation uses a standard shell, `tar`, `sha256sum`, and `nohup`; native Windows uses PowerShell, `tar.exe`, and OpenSSH. The local Host downloads Node and target native dependencies over HTTPS, verifies checksums, and uploads the payload. Allow local access to the configured distribution and registry URLs. Confirm the fingerprint through an independent trusted channel before installation.

Authentication tries the local SSH agent and available default private keys, or an explicit `identityFile`; a supplied password is memory-only. At startup, the Host attempts each saved connection once in the background without delaying the interface. A failed attempt leaves the computer registered and exposes the error in its status tooltip; use its connection controls to retry or supply a password. Unlock encrypted keys in the SSH agent. The password field does not supply a private-key passphrase. A saved computer cannot be moved to another host, port, or SSH account; create another computer registration instead.

### Configuration

Patch the existing `remote-work` row in a shipped profile; custom compositions must replace their filesystem provider with this router while retaining local subprocess, sandbox-policy, and sandbox-aware shell services. The standard and Cordis presets expose both native command tools with `nativePlatformOnly: true`. Do not replace the global local subprocess provider: model adapters, MCP, and other local orchestration still use it.

```yaml
- id: remote-work
  config:
    commandTimeoutMs: 60000
```

| Field | Default | Meaning |
|---|---|---|
| `nodeVersion` | `24.15.0` | Private Node release downloaded locally |
| `commandTimeoutMs` | `60000` | Default remote command deadline in milliseconds |
| `maxCommandTimeoutMs` | `600000` | Maximum admitted command deadline |
| `connectTimeoutMs` | `300000` | One SSH and installation attempt deadline |
| `maxOutputBytes` | `8388608` | Retained bytes per process output stream |
| `maxProcesses` | `128` | Process records; completed records can expire |
| `maxRememberedOperations` | `128` | Recoverable mutation results |
| `localFilesystem` | `{}` | Options for the routed local filesystem |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-remote-work) owns the complete field list. Resource limits apply to a Runtime generation; reconnecting to an already running generation does not reconfigure its process limits.

### Interruption and recovery

Connection loss pauses new model steps and remote observations while the Host reconnects. Existing command and terminal processes belong to the remote Runtime, not the SSH transport. Reconnection attaches to their retained output and state. Explicit command deadlines and user cancellation still apply. Disconnecting a computer suspends its attachment until it is connected again or the application restarts; it does not stop remote tasks.

A mutation receives an operation ID before transmission. After an interrupted reply, the Host retrieves that operation's result without resubmitting it. A missing result or replaced Runtime reports `REMOTE_OUTCOME_UNKNOWN`; inspect the remote files or process before deciding whether to retry. Terminal input follows the same rule. Output truncation is reported, and completed records have bounded retention. Runtime restart, remote reboot, and a different payload generation do not preserve in-memory task recovery.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Each saved computer owns a verified SSH identity and a Host signing key in local storage. Ed25519 signatures over fresh nonces authenticate both endpoints. Only the Host public authorization key is uploaded; the daemon creates a private identity in memory and advertises its public key through the SSH-read endpoint file. Reading remote configuration does not grant RPC authority, and a reused port cannot impersonate the daemon. Runtime installations live under the SSH user's data directory and are identified by payload digest. Linux detaches the Runtime with `nohup`; Windows starts it outside the OpenSSH job. No Agent or model adapter runs in that payload.

A computer-qualified `dsh-ssh://` directory identifies the Session's execution computer. Filesystem routing and a registered per-Agent execution context select remote providers while the Agent context remains local. An absent remote provider fails instead of falling back to local execution. Native V4 headers retain these addresses; older readers refuse them during header validation, before executing the Session. Existing native absolute-directory headers remain readable without migration.

The Runtime owns process records and bounded byte streams. The Host pages base64 output with byte offsets, reconnects observations, and recovers mutation results by operation ID. See [connection supervision](src/connection.ts), [execution routing](src/filesystem.ts), and [Runtime ownership](src/runtime-server.ts) for the implementation.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Workspace UI](../../client/ui-workspace/README.md) — computer and folder navigation.
- [Client computer model](../../client/remote-work/README.md) — connection state and administration.
- [SSH providers](../ssh/README.md) — separately composed POSIX helper deployments.
- [Sandbox policy](../../sandbox/sandbox-policy/README.md) — write permissions.

-----

<a id="model-experience"></a>
## Model Experience

### Remote computer runtime context

#### What the model sees

A required context identifies the selected computer and native platform. `{name}` is JSON-quoted and `{platform}` is `Linux` or `Windows`; file, search, command, and terminal consumers own their tool declarations and result presentation.

##### Computer context template

```markdown
Files, commands and terminals run on remote computer {name} ({platform}). The Agent and model connection run locally. If the connection is interrupted, wait for reconnection; do not repeat an operation whose outcome is unknown.
```

#### Token effect

One bounded paragraph is independent of conversation length; the saved computer name contributes variable text.

#### KV Cache effect

The context is stable for one Agent attachment. Resuming an Agent captures the saved computer metadata again and can replace this context; unchanged earlier request content remains reusable under the provider's caching rules.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The execution Runtime has these limits:

- Linux x64 and Windows x64 have live validation. ARM64 packaging has not been validated.
- Persistent-shell minimal and PTC presets are unsupported for remote Sessions; use standard or Cordis.
- SSH configuration aliases, jump hosts, interactive multi-factor prompts, and automatic computer removal are not supplied.
- Recovery is bounded and memory-only; changing Runtime generation does not migrate live processes or terminal state.
- The remote SSH account and its operating system are trusted; process-memory inspection and hostile-host attestation are outside this provider. Sandbox modes restrict writes, not general file reads.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
