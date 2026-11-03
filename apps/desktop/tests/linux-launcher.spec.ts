/** The local AppImage launcher preserves arguments and never silently disables the sandbox. */

import { execFile } from 'node:child_process'
import { chmod, copyFile, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

it.skipIf(process.platform === 'win32')('starts the bundled executable without a namespace-probe sandbox fallback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'desktop-appimage-中文 '))
  try {
    await copyFile(new URL('../resources/AppRun', import.meta.url), join(root, 'AppRun'))
    await chmod(join(root, 'AppRun'), 0o755)
    await symlink(process.execPath, join(root, 'deepseek-harness'))
    const args = ['中文 path', '$HOME', '']
    const { stdout } = await promisify(execFile)(join(root, 'AppRun'), [
      '-e', 'console.log(JSON.stringify({ args: process.argv.slice(1), cwd: process.cwd() }))', '--', ...args,
    ], { cwd: root, env: { APPDIR: root, PATH: '' } })
    expect(JSON.parse(stdout)).toEqual({ args, cwd: root })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
