# Agent Note: Local orchestration and reconnectable remote execution

Status: implemented

English | [中文](2026-11-04-local-orchestration-remote-execution.zh.md)

## Problem

A desktop Agent must work on Linux and native Windows computers without moving model credentials or conversation storage to those computers. SSH interruption must not kill accepted work, and reconnecting must not repeat a file mutation or terminal input whose outcome is uncertain. A global provider replacement also affects local orchestration, including MCP subprocesses, rather than only the selected Session.

## Decision

Remote work binds execution services per Agent while retaining the Agent context locally. Filesystem routing preserves the original computer-qualified project identity; shell tools, search, and browser terminals select the registered execution context. Missing execution services for a qualified Session fail instead of falling back locally. Native command admission follows the Session's subprocess environment, not the Host platform.

The execution-only Runtime runs under the remote SSH account and owns managed processes, terminals, bounded output, and mutation-result records. SSH is an attachment, not the process owner. Linux detaches with `nohup`; Windows breaks out of the OpenSSH job. Downloads and checksum verification occur locally before installation. This is separate from the [POSIX helper providers](2026-09-11-posix-ssh-runtime.md), whose connection-owned cleanup and explicit deployment remain supported.

### Authentication authority

The Host retains an Ed25519 signing key in local storage and uploads only its public authorization key. The Runtime generates its own signing key in memory and publishes only its public key in the endpoint file read through verified SSH. Fresh nonces and role-specific signatures authenticate both sides before large RPC buffers are admitted. Reading remote configuration therefore does not grant control authority. Node debugger activation through `SIGUSR1` is disabled for the daemon and its Windows launcher.

The remote account and operating system remain trusted. The design does not attest a hostile host or prevent process-memory inspection. Public-key endpoint discovery relies on the installation directory's write protection; the sandbox's read permissions are not treated as confidentiality protection.

### Recovery ownership

Observations wait for automatic reconnection. Each mutation has an operation ID allocated before transmission; reconnecting retrieves that ID's original result without resubmitting the operation. A missing record, an oversized unrecoverable result, or a different daemon instance reports an unknown outcome. Terminal input uses the same rule. Retained process bytes use offsets and bounded base64 pages so multibyte text and binary data survive a transport replacement without text decoding at page boundaries.

Model-step preparation waits for the selected computer. An explicit disconnect suspends attachment rather than stopping its tasks. Explicit stops and task deadlines retain their authority. Daemon restart, reboot, and a new payload generation do not reconstruct in-memory tasks or terminal state.

### Same-version directory admission

The immutable creation `cwd` carries `dsh-ssh://<computer-uuid>/<encoded-native-path>`; working-directory events continue to carry the resolved execution path. No Session type changes from `string`, and no new header field is introduced. Native V4 codecs own execution-address admission independently of the reused V2 row framing; historical V2 and V3 header admission stays unchanged.

Keeping V4 follows the [reader-compatibility rule](../../../../docs/persistence-changes/README.md#compatibility-rules): new readers retain every prior native absolute-directory header, while older readers reject an execution URI during header validation, before body recovery, truncation, or execution. The URI is an effective refusal signal, not optional metadata an older reader can ignore. This behavior-only review has no declared persistence-schema delta. Existing committed Session generations remain untouched.

## Alternatives considered

**Run the entire Harness remotely.** That moves model credentials, Session persistence, and orchestration with execution, contrary to the local-ownership requirement.

**Replace global subprocess and sandbox providers.** Local plugin processes would follow the remote filesystem and environment, so a Session selection could relocate MCP or other Host work.

**Tie work to SSH or replay after reconnect.** Connection-owned cleanup loses accepted jobs; automatic replay can duplicate edits, launches, and terminal input. Stable operation IDs and explicit unknown outcomes preserve those distinctions.

**Store a shared control secret in remote configuration.** Write confinement permits reading that file. A readable shared secret would let confined code request unrestricted Runtime operations. Public authorization keys avoid granting authority through file reads.

**Advance the Session format solely for remote cwd.** Existing header validation already refuses the new address form safely, and all previous headers retain their meaning. A new integer version adds a migration without resolving another interpretation problem.

## Consequences

The Host owns saved computer identities and attachment lifetimes; the daemon owns accepted work. Recovery consumes bounded memory and cannot promise every completed record or unlimited historical output. Users inspect remote state before retrying an unknown outcome. Standard and Cordis presets support this arrangement; persistent-shell minimal and PTC presets remain unsupported for remote Sessions.

The POSIX helper decision remains active for its distinct deployment, stream, and lease guarantees. No active note is fully superseded. The [package reference](../../../../packages/ssh/remote-work/README.md) owns supported prerequisites and limits rather than this rationale.

## Verification

The [real Web composition test](../../../../apps/web/tests/remote-work.e2e.ts) uses only a scripted external model, executes remote file and native-shell effects, checks local Agent ownership and recorded context, and verifies that installed configuration contains no private key. Linux and native Windows run the same scenario. [Runtime tests](../../../../packages/ssh/remote-work/tests/runtime.spec.ts) cover unauthorized keys, endpoint identity, transport replacement, byte paging, guarded file effects, and mutation recovery. Live SSH interruption checks also preserve one daemon and terminal environment, recover a committed mutation, and report a forgotten result without replay.
