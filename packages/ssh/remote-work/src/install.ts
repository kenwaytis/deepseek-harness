/** Versioned, user-owned SSH installation. All downloads happen on the local computer. */
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, mkdtemp, cp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { create as createTar, extract as extractTar } from 'tar'
import { z } from 'zod'
import { setTimeout as delay } from 'node:timers/promises'
import { authenticateRuntimeClient, runtimeAuthorizationKey } from './authentication.ts'
import { SshSession, powershell, psQuote, shQuote } from './ssh-session.ts'

/** Verified OS facts used to select an embedded Node distribution. */
export interface RemotePlatform {
  readonly platform: 'linux' | 'win32'
  readonly arch: 'x64' | 'arm64'
  readonly home: string
  readonly root: string
}
/** Installer inputs owned by the local plugin configuration. */
export interface InstallConfig {
  readonly cacheDirectory: string
  readonly runtimeDirectory: string
  readonly nodeVersion: string
  readonly nodeDistributionUrl: string
  readonly nativeRegistryUrl: string
  readonly maxDownloadBytes: number
  readonly maxProcesses: number
  readonly maxOutputBytes: number
  readonly readChunkBytes: number
  readonly maxRememberedOperations: number
  readonly maxFrameBytes: number
  readonly authenticationTimeoutMs: number
  readonly maxConnections: number
  readonly keepaliveIntervalMs: number
  readonly keepaliveMax: number
  readonly runtimeStartupTimeoutMs: number
  readonly pollIntervalMs: number
}

/**
 * Probe native Windows or Linux without invoking a preinstalled Node executable.
 * @param ssh - authenticated SSH transport.
 * @param signal - probe cancellation.
 * @returns target OS, CPU and user-owned installation root.
 */
export async function probePlatform(ssh: SshSession, signal: AbortSignal): Promise<RemotePlatform> {
  try {
    const raw = await ssh.exec('uname -s; uname -m; printf "%s\\n" "$HOME"', signal)
    const [os, architecture, home] = raw.split(/\r?\n/u)
    if (os !== 'Linux' || home === undefined || !home.startsWith('/')) throw new Error('Not a Linux SSH host')
    const arch = architecture === 'x86_64' ? 'x64' : architecture === 'aarch64' ? 'arm64' : undefined
    if (arch === undefined) throw new Error(`Unsupported Linux architecture: ${architecture}`)
    return { platform: 'linux', arch, home, root: `${home}/.local/share/deepseek-harness/remote-work` }
  } catch (linuxError) {
    signal.throwIfAborted()
    try {
      const raw = await ssh.exec(
        powershell(
          '@{home=$env:USERPROFILE; root=(Join-Path $env:LOCALAPPDATA "DeepSeekHarness/remote-work"); arch=$env:PROCESSOR_ARCHITECTURE} | ConvertTo-Json -Compress',
        ),
        signal,
      )
      const value = z
        .object({ home: z.string(), root: z.string(), arch: z.enum(['AMD64', 'ARM64']) })
        .parse(JSON.parse(raw))
      return { platform: 'win32', arch: value.arch === 'AMD64' ? 'x64' : 'arm64', home: value.home, root: value.root }
    } catch (windowsError) {
      throw new AggregateError(
        [linuxError, windowsError],
        'Remote work supports Linux and native Windows with a standard SSH shell',
      )
    }
  }
}

async function download(url: string, maximum: number, signal: AbortSignal): Promise<Buffer> {
  const response = await fetch(url, { signal, redirect: 'error' })
  if (!response.ok || response.body === null)
    throw new Error(`Runtime download failed: HTTP ${response.status} (${url})`)
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of response.body) {
    bytes += chunk.byteLength
    if (bytes > maximum) throw new Error(`Runtime download exceeds ${maximum} bytes`)
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

async function nodeArchive(
  config: InstallConfig,
  platform: RemotePlatform,
  signal: AbortSignal,
): Promise<{ file: string; name: string; digest: string }> {
  const os = platform.platform === 'win32' ? 'win' : 'linux'
  const name = `node-v${config.nodeVersion}-${os}-${platform.arch}.${os === 'win' ? 'zip' : 'tar.gz'}`
  const base = `${config.nodeDistributionUrl.replace(/\/$/u, '')}/v${config.nodeVersion}`
  await mkdir(config.cacheDirectory, { recursive: true, mode: 0o700 })
  const sums = (await download(`${base}/SHASUMS256.txt`, 128 * 1024, signal)).toString('utf8')
  const line = sums.split('\n').find(value => value.endsWith(`  ${name}`))
  const digest = line?.slice(0, 64)
  if (digest === undefined || !/^[0-9a-f]{64}$/u.test(digest))
    throw new Error(`Node distribution has no checksum for ${name}`)
  const file = join(config.cacheDirectory, name)
  let existing: Buffer | undefined
  try {
    existing = await readFile(file)
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  }
  if (existing === undefined || createHash('sha256').update(existing).digest('hex') !== digest) {
    const bytes = await download(`${base}/${name}`, config.maxDownloadBytes, signal)
    if (createHash('sha256').update(bytes).digest('hex') !== digest)
      throw new Error('Downloaded Node runtime checksum mismatch')
    await writeFile(file, bytes, { mode: 0o600 })
  }
  return { file, name, digest }
}

async function preparePayload(
  config: InstallConfig,
  platform: RemotePlatform,
  staging: string,
  signal: AbortSignal,
): Promise<string> {
  const payload = join(staging, 'payload')
  await cp(config.runtimeDirectory, payload, { recursive: true, dereference: true })
  for (const [name, manifest] of [
    [`@koromix/koffi-${platform.platform}-${platform.arch}`, 'node_modules/koffi/package.json'],
    [`@vscode/ripgrep-${platform.platform}-${platform.arch}`, 'ripgrep-package.json'],
  ] as const) {
    const input: unknown = JSON.parse(await readFile(join(payload, manifest), 'utf8'))
    const { version } = z
      .object({ version: z.string().regex(/^\d+\.\d+\.\d+$/u) })
      .loose()
      .parse(input)
    const registry = config.nativeRegistryUrl.replace(/\/$/u, '')
    const metadata = z
      .object({ dist: z.object({ tarball: z.url(), integrity: z.string().startsWith('sha512-') }).loose() })
      .loose()
      .parse(
        JSON.parse(
          (await download(`${registry}/${encodeURIComponent(name)}/${version}`, 128 * 1024, signal)).toString('utf8'),
        ),
      )
    if (new URL(metadata.dist.tarball).protocol !== 'https:') throw new Error('Native runtime download requires HTTPS')
    const archive = await download(metadata.dist.tarball, config.maxDownloadBytes, signal)
    if (`sha512-${createHash('sha512').update(archive).digest('base64')}` !== metadata.dist.integrity)
      throw new Error('Native runtime checksum mismatch')
    const file = join(staging, `${name.split('/')[1]}.tgz`)
    await writeFile(file, archive)
    const target = join(payload, 'node_modules', name)
    await mkdir(target, { recursive: true })
    await extractTar({ file, cwd: target, strip: 1, strict: true })
  }
  return payload
}

const windowsLauncher = `using System; using System.Runtime.InteropServices;
public class DshRemoteLauncher {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct STARTUPINFO { public int cb; public string reserved,desktop,title; public int x,y,xSize,ySize,xCount,yCount,fill,flags; public short show,bytes; public IntPtr reserved2,input,output,error; }
 [StructLayout(LayoutKind.Sequential)] public struct PROCESS_INFORMATION { public IntPtr process,thread; public int pid,tid; }
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string app,string cmd,IntPtr pa,IntPtr ta,bool inherit,int flags,IntPtr env,string cwd,ref STARTUPINFO si,out PROCESS_INFORMATION pi);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
 public static void Start(string app,string cmd,string cwd) { var si=new STARTUPINFO(); si.cb=Marshal.SizeOf(si); PROCESS_INFORMATION pi; if(!CreateProcess(app,cmd,IntPtr.Zero,IntPtr.Zero,false,0x01000000|0x08000000|0x00000200,IntPtr.Zero,cwd,ref si,out pi)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); CloseHandle(pi.thread); CloseHandle(pi.process); }
}`

/** Installed immutable generation and its current daemon endpoint. */
export interface Installation {
  readonly root: string
  readonly port: number
  readonly publicKey: string
  readonly version: string
}

/**
 * Upload a versioned Runtime and start it outside the SSH session's process ownership.
 * @param ssh - authenticated connection.
 * @param platform - verified target facts.
 * @param computerId - installation namespace; separate computer registrations do not share capabilities.
 * @param privateKey - Host signing key; only its public authorization key is uploaded.
 * @param config - local artifacts and resource limits.
 * @param signal - finite installation cancellation.
 * @returns installed generation and loopback endpoint; existing live work is not replaced.
 */
export async function installRuntime(
  ssh: SshSession,
  platform: RemotePlatform,
  computerId: string,
  privateKey: string,
  config: InstallConfig,
  signal: AbortSignal,
): Promise<Installation> {
  const manifest = await readFile(join(config.runtimeDirectory, 'payload.json'))
  const version = createHash('sha256')
    .update(manifest)
    .update(platform.platform)
    .update(platform.arch)
    .digest('hex')
    .slice(0, 24)
  const slash = platform.platform === 'win32' ? '\\' : '/'
  const root = `${platform.root}${slash}${computerId}${slash}${version}`
  const endpointPath = `${root}${slash}endpoint.json`
  const readEndpoint = async (): Promise<{ port: number; publicKey: string } | undefined> => {
    try {
      const raw = await ssh.exec(
        platform.platform === 'win32'
          ? powershell(
            `if(Test-Path -LiteralPath ${psQuote(endpointPath)}) { Get-Content -Raw -LiteralPath ${psQuote(endpointPath)} }`,
          )
          : `test ! -f ${shQuote(endpointPath)} || cat ${shQuote(endpointPath)}`,
        signal,
      )
      if (raw === '') return undefined
      return z
        .object({ port: z.number().int().min(1).max(65535), publicKey: z.string().min(1).max(256) })
        .loose()
        .parse(JSON.parse(raw))
    } catch (error) {
      signal.throwIfAborted()
      throw new Error('Cannot inspect the installed remote Runtime', { cause: error })
    }
  }
  const existing = await readEndpoint()
  if (existing !== undefined) {
    try {
      const channel = await ssh.forward(existing.port)
      try {
        await authenticateRuntimeClient(
          channel,
          privateKey,
          existing.publicKey,
          AbortSignal.any([signal, AbortSignal.timeout(config.authenticationTimeoutMs)]),
        )
      } finally {
        channel.destroy()
      }
      return { root, ...existing, version }
    } catch (error) {
      signal.throwIfAborted()
      // SSH_OPEN_CONNECT_FAILED (RFC 4254) means no listener could be reached; other failures retain the existing installation.
      if (!(error instanceof Error && 'reason' in error && error.reason === 2)) throw error
    }
  }
  const node = await nodeArchive(config, platform, signal)
  await ssh.exec(
    platform.platform === 'win32'
      ? powershell(`New-Item -ItemType Directory -Force -Path ${psQuote(root)} | Out-Null`)
      : `umask 077; mkdir -p ${shQuote(root)}`,
    signal,
  )
  const staging = await mkdtemp(join(config.cacheDirectory, 'install-'))
  const payloadDirectory = await preparePayload(config, platform, staging, signal)
  const archive = join(staging, 'payload.tar.gz')
  await createTar({ cwd: payloadDirectory, file: archive, gzip: true, portable: true }, ['.'])
  const transfer = await ssh.sftp()
  const upload = (local: string, remote: string): Promise<void> =>
    new Promise((resolve, reject) => {
      transfer.fastPut(local, remote.replaceAll('\\', '/'), (error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  const remoteNode = `${root}${slash}${node.name}`
  const payload = `${root}${slash}payload.tar.gz`
  const runtimeConfig = JSON.stringify({
    authorizedKey: runtimeAuthorizationKey(privateKey),
    version,
    maxProcesses: config.maxProcesses,
    maxOutputBytes: config.maxOutputBytes,
    readChunkBytes: config.readChunkBytes,
    maxRememberedOperations: config.maxRememberedOperations,
    maxFrameBytes: config.maxFrameBytes,
    authenticationTimeoutMs: config.authenticationTimeoutMs,
    maxConnections: config.maxConnections,
  })
  const configPath = join(config.cacheDirectory, `${computerId}.runtime.json`)
  await writeFile(configPath, runtimeConfig, { mode: 0o600 })
  try {
    await upload(node.file, remoteNode)
    await upload(archive, payload)
    await upload(configPath, `${root}${slash}runtime.json`)
  } finally {
    transfer.end()
    await rm(configPath, { force: true })
  }
  const payloadDigest = createHash('sha256')
    .update(await readFile(archive))
    .digest('hex')
  await rm(staging, { recursive: true, force: true })
  const executable = `${root}${slash}node${slash}${platform.platform === 'win32' ? 'node.exe' : 'bin/node'}`
  if (platform.platform === 'win32') {
    await ssh.exec(
      powershell(`$root=${psQuote(root)};
      if((Get-FileHash -Algorithm SHA256 -LiteralPath ${psQuote(remoteNode)}).Hash.ToLowerInvariant() -ne ${psQuote(node.digest)}) { throw 'Node checksum mismatch' };
      if((Get-FileHash -Algorithm SHA256 -LiteralPath ${psQuote(payload)}).Hash.ToLowerInvariant() -ne ${psQuote(payloadDigest)}) { throw 'Runtime checksum mismatch' };
      & tar.exe -xzf ${psQuote(payload)} -C $root; if($LASTEXITCODE -ne 0) { throw 'Runtime extraction failed' };
      if(!(Test-Path -LiteralPath ${psQuote(executable)})) { Expand-Archive -LiteralPath ${psQuote(remoteNode)} -DestinationPath $root -Force; Move-Item -LiteralPath (Join-Path $root ${psQuote(node.name.replace(/\.zip$/u, ''))}) -Destination (Join-Path $root 'node') };
      Remove-Item -LiteralPath ${psQuote(endpointPath)} -ErrorAction SilentlyContinue;
      Add-Type -TypeDefinition ${psQuote(windowsLauncher)};
      [DshRemoteLauncher]::Start(${psQuote(executable)}, ${psQuote(`"${executable}" --disable-sigusr1 "${root}\\launch.cjs"`)}, $root);
      $limit=(Get-Date).AddMilliseconds(${config.runtimeStartupTimeoutMs}); while(!(Test-Path -LiteralPath ${psQuote(endpointPath)})) { if((Get-Date) -gt $limit) { throw 'Remote Runtime startup timed out' }; Start-Sleep -Milliseconds ${config.pollIntervalMs} }`),
      signal,
    )
  } else {
    const directory = node.name.replace(/\.tar\.gz$/u, '')
    await ssh.exec(
      `set -eu; cd ${shQuote(root)}; printf '%s  %s\\n' ${shQuote(node.digest)} ${shQuote(node.name)} | sha256sum -c -; printf '%s  %s\\n' ${shQuote(payloadDigest)} payload.tar.gz | sha256sum -c -; tar -xzf payload.tar.gz; if test ! -x node/bin/node; then tar -xzf ${shQuote(node.name)}; mv ${shQuote(directory)} node; fi; chmod -R go-rwx .; rm -f endpoint.json; nohup ${shQuote(executable)} --disable-sigusr1 lib/server.mjs </dev/null >>runtime.log 2>&1 &`,
      signal,
    )
  }
  const deadline = Date.now() + config.runtimeStartupTimeoutMs
  let endpoint = await readEndpoint()
  while (endpoint === undefined && Date.now() < deadline) {
    await delay(config.pollIntervalMs, undefined, { signal })
    endpoint = await readEndpoint()
  }
  if (endpoint === undefined)
    throw new Error('Remote Runtime did not publish an endpoint; inspect runtime.log on the remote computer')
  return { root, ...endpoint, version }
}
