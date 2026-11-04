/** Opt-in real SSH execution through the shipped Web Loader, with only the external model scripted. */
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser } from 'playwright'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-remote-work'
import { remoteDirectoryOf } from '@deepseek-ai/dsh-util-workspace-path'
import { SshSession, powershell, psQuote, shQuote } from '@deepseek-ai/dsh-remote-work/src/ssh-session.ts'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'
import { saveFailureShot } from './support.ts'

const host = process.env.DSH_REMOTE_WORK_HOST
const processPage = z.looseObject({
  output: z.looseObject({ stdout: z.looseObject({ data: z.string() }) }),
  outcome: z.looseObject({ exitCode: z.number().nullable() }).nullable(),
  error: z.string().nullable(),
})

it.skipIf(host === undefined)(
  'runs a local Agent against an SSH computer through the real Web composition',
  async () => {
    const username = process.env.DSH_REMOTE_WORK_USERNAME
    const fingerprint = process.env.DSH_REMOTE_WORK_FINGERPRINT
    const platform = process.env.DSH_REMOTE_WORK_PLATFORM
    if (
      host === undefined ||
      username === undefined ||
      fingerprint === undefined ||
      (platform !== 'linux' && platform !== 'win32')
    ) {
      throw new Error(
        'Set DSH_REMOTE_WORK_HOST, USERNAME, FINGERPRINT and PLATFORM (linux or win32) for the SSH composition test',
      )
    }
    const port = Number(process.env.DSH_REMOTE_WORK_PORT ?? 22)
    const root = await mkdtemp(join(tmpdir(), 'dsh-remote-web-'))
    let scaffold: WebScaffold | undefined = undefined
    let browser: Browser | undefined = undefined
    let remoteCleanup: (() => Promise<void>) | undefined = undefined
    onTestFinished(async () => {
      const failures: unknown[] = []
      for (const clean of [
        async () => browser?.close(),
        async () => scaffold?.close(),
        async () => remoteCleanup?.(),
        async () => rm(root, { recursive: true, force: true }),
      ]) {
        try {
          await clean()
        } catch (error: unknown) {
          failures.push(error)
        }
      }
      if (failures.length > 0) throw new AggregateError(failures, 'Remote Web composition cleanup failed')
    })
    const fixture = new URL('../../../packages/ssh/remote-work/tests/fixtures/scripted-llm.ts', import.meta.url)
    const overlay = join(root, 'remote-work.overlay.yml')
    await writeFile(
      overlay,
      `- insert:\n    - id: remote-work-test-llm\n      name: ${JSON.stringify(fixture.href)}\n      config:\n        remotePlatform: ${platform}\n- id: remote-work\n  config:\n    cacheDirectory: ${JSON.stringify(join(root, 'cache'))}\n- id: session-title-llm\n  disabled: true\n`,
    )
    scaffold = await launchWebScaffold({
      extraOverlayPath: [fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)), overlay],
    })
    const app = scaffold
    const manager = app.ctx.get('remoteWork')
    if (manager === undefined) throw new Error('The shipped Web composition did not provide remoteWork')
    app.ctx.on('agent/created', ({ agent }) => {
      if (agent.session.header.cwd !== undefined && remoteDirectoryOf(agent.session.header.cwd) !== undefined) {
        agent.model.select({ provider: 'remote-work-test', model: 'scripted' })
      }
    })
    browser = await chromium.launch()
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' })
    onTestFailed(() => saveFailureShot(page, `remote-work-${platform}`))
    await page.goto(app.authenticatedUrl, { waitUntil: 'load' })
    await page.getByRole('button', { name: '添加', exact: true }).click()
    await page.getByRole('menuitem', { name: '通过 SSH 连接电脑', exact: true }).click()
    await page.getByLabel('电脑名称', { exact: true }).fill('SSH composition computer')
    await page.getByLabel('主机地址', { exact: true }).fill(host)
    await page.getByLabel('SSH 端口', { exact: true }).fill(String(port))
    await page.getByLabel('SSH 用户名', { exact: true }).fill(username)
    await page.getByRole('button', { name: '连接', exact: true }).click()
    const shownFingerprint = page.getByRole('dialog').locator('code')
    await shownFingerprint.waitFor({ timeout: 20_000 })
    expect(await shownFingerprint.textContent()).toBe(fingerprint)
    await page.getByRole('button', { name: '信任并安装', exact: true }).click()
    await page.getByRole('dialog').waitFor({ state: 'hidden', timeout: 180_000 })
    const computer = manager.list().find(state => state.computer.name === 'SSH composition computer')?.computer
    if (computer === undefined) throw new Error('The connected computer was not persisted')
    const transientCaller = await app.ctx.plugin({
      name: 'remote-work-transient-caller',
      inject: ['remoteWork'],
      apply(inner: Context) {
        inner.remoteWork.filesystem(computer.id)
      },
    })
    await transientCaller.dispose()
    const connection = manager.connection(computer.id)
    const hello = await connection.connect()
    const native = connection.platform
    if (native === undefined || native.platform !== platform)
      throw new Error('The SSH target did not match the configured native platform')
    const separator = platform === 'win32' ? '\\' : '/'
    const generationRoot = `${native.root}${separator}${computer.id}`
    let workspace: string | undefined = undefined
    remoteCleanup = async () => {
      const ssh = new SshSession({ name: 'Remote Web cleanup', host, port, username, fingerprint }, 15_000, 1000, 2)
      try {
        await ssh.connect(AbortSignal.timeout(15_000))
        const command =
          platform === 'win32'
            ? powershell(
              `$ErrorActionPreference='Stop'; Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq ${psQuote(hello.executable)} } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; ${workspace === undefined ? '' : `Remove-Item -LiteralPath ${psQuote(workspace)} -Recurse -Force;`} Remove-Item -LiteralPath ${psQuote(generationRoot)} -Recurse -Force`,
            )
            : `for entry in /proc/[0-9]*/exe; do if test "$(readlink "$entry" 2>/dev/null || true)" = ${shQuote(hello.executable)}; then pid="\${entry%/exe}"; kill -TERM "\${pid##*/}"; fi; done; ${workspace === undefined ? '' : `rm -rf -- ${shQuote(workspace)};`} rm -rf -- ${shQuote(generationRoot)}`
        await ssh.exec(command, AbortSignal.timeout(30_000))
      } finally {
        await ssh.close()
      }
    }
    const creation = randomUUID()
    await connection.request(
      'process.start',
      {
        id: creation,
        spec: {
          argv: [
            hello.executable,
            '-e',
            "const fs=require('node:fs'),path=require('node:path');const root=fs.mkdtempSync(path.join(require('node:os').tmpdir(),'dsh-web-remote-'));fs.writeFileSync(path.join(root,'runtime-result.txt'),'remote-input\\n');console.log(root)",
          ],
          cwd: hello.home,
          graceMs: 1000,
          stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
        },
      },
      z.unknown(),
    )
    const observe = () =>
      connection.request('process.read', { id: creation, offsets: {} }, processPage, AbortSignal.timeout(10_000), true)
    await expect.poll(async () => (await observe()).outcome?.exitCode, { timeout: 30_000 }).toBe(0)
    workspace = Buffer.from((await observe()).output.stdout.data, 'base64')
      .toString('utf8')
      .trim()
    const folder = basename(workspace.replaceAll('\\', '/'))
    await page.getByRole('button', { name: '在“SSH composition computer”中添加文件夹', exact: true }).click()
    const directoryInput = page.getByLabel('远端文件夹路径', { exact: true })
    await directoryInput.fill(workspace)
    await page.getByRole('button', { name: '浏览', exact: true }).click()
    await expect.poll(() => directoryInput.isEnabled()).toBe(true)
    expect(await directoryInput.inputValue()).toBe(workspace)
    await page.getByRole('button', { name: '添加此文件夹', exact: true }).click()
    await page.getByRole('dialog').waitFor({ state: 'hidden' })
    const group = page.getByRole('group', { name: 'SSH composition computer', exact: true })
    await group.getByText(folder, { exact: true }).click()
    await group.getByRole('button', { name: `在“${folder}”中新建会话`, exact: true }).click()
    await page
      .locator('[contenteditable=true]')
      .first()
      .fill('Exercise remote file tools and the native execution shell.')
    const settled = app.whenTurnSettled(120_000)
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    const sessionId = await settled
    await page
      .getByText(`Agent host platform: ${process.platform}. Remote workflow completed.`, { exact: true })
      .waitFor()
    const agent = app.ctx.agents.get(sessionId)
    if (agent === undefined) throw new Error('The local Agent was not retained')
    expect(remoteDirectoryOf(agent.session.header.cwd ?? '')).toEqual({ computerId: computer.id, path: workspace })
    const execution = app.ctx.agents.executionContext(agent)
    expect(execution.get('subprocess') === app.ctx.subprocess).toBe(false)
    expect(execution.get('shell') === app.ctx.shell).toBe(false)
    const events = agent.session.snapshotEvents()
    const computerContext = events
      .filter(event => event.type === 'user/message')
      .flatMap(event =>
        event.data.source.kind === 'runtime-context' && event.data.source.form === 'snapshot'
          ? event.data.source.sections
          : [],
      )
      .find(section => section.name === 'remote-work:computer')?.text
    expect(computerContext).toBeDefined()
    await expect(`${computerContext}\n`).toMatchFileSnapshot(
      fileURLToPath(new URL(`./remote-work-${platform}.expected.txt`, import.meta.url)),
    )
    expect(events.filter(event => event.type === 'tool/call').map(event => event.data.name)).toEqual([
      'read',
      'write',
      platform === 'win32' ? 'pwsh' : 'bash',
    ])
    expect(events.filter(event => event.type === 'tool/result').map(event => event.data.message.isError)).toEqual([
      false,
      false,
      false,
    ])
    const fs = manager.filesystem(computer.id)
    const installed = await fs.readText(
      await fs.resolve(`${generationRoot}${separator}${hello.version}${separator}runtime.json`),
    )
    const publicConfig: unknown = JSON.parse(installed)
    expect(z.object({ authorizedKey: z.base64() }).loose().safeParse(publicConfig).success).toBe(true)
    expect(publicConfig).not.toHaveProperty('privateKey')
    expect(publicConfig).not.toHaveProperty('token')
    expect(installed).not.toContain('PRIVATE KEY')
    expect(await fs.readText(await fs.resolve(`${workspace}${separator}runtime-result.txt`))).toBe(
      'remote-runtime-file\n',
    )
    expect((await fs.readText(await fs.resolve(`${workspace}${separator}runtime-command.txt`))).trim()).toBe(
      'remote-command-ok',
    )
    await expect(access(join(app.workspaceCwd, 'runtime-command.txt'))).rejects.toThrow()
  },
  240_000,
)
