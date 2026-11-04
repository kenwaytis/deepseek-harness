/** Build the execution-only SSH payload, including native resources but excluding Node itself. */
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { build } from 'tsdown'
import ts from 'typescript'

/**
 * Bundle remote execution entries and copy their runtime-loaded native dependencies.
 * @param root - repository root.
 * @returns after the relocatable payload is complete.
 */
export async function buildRemoteWorkRuntime(root: string): Promise<void> {
  const output = join(root, 'packages/ssh/remote-work/lib/runtime')
  await rm(output, { recursive: true, force: true })
  await mkdir(join(output, 'lib'), { recursive: true })
  const parsed = ts.readConfigFile(join(root, 'tsconfig.base.json'), file => ts.sys.readFile(file)).config as {
    compilerOptions: { paths: Record<string, string[]> }
  }
  const alias: Record<string, string> = {}
  for (const [name, targets] of Object.entries(parsed.compilerOptions.paths)) {
    if (name.includes('*') || targets[0] === undefined || !targets[0].includes('/src/')) continue
    const emitted = targets[0].replace('/src/', '/lib/types/').replace(/\.tsx?$/u, '.js')
    if (existsSync(resolve(root, emitted))) alias[name] = resolve(root, emitted)
  }
  await build({
    config: false,
    cwd: root,
    tsconfig: false,
    inputOptions: { tsconfig: false },
    alias,
    entry: {
      server: 'packages/ssh/remote-work/lib/types/runtime-entry.js',
      runner: 'packages/subprocess/subprocess-local/lib/types/bin.js',
      'acl-runner': 'packages/sandbox/sandbox-windows-acl/lib/types/runner.js',
    },
    outDir: join(output, 'lib'),
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    dts: false,
    clean: false,
    outExtensions: () => ({ js: '.mjs' }),
    deps: {
      alwaysBundle: name =>
        !name.startsWith('node:') &&
        !name.startsWith('@deepseek-ai/node-addon-system') &&
        name !== 'node-pty' &&
        name !== 'koffi',
      neverBundle: [/^@deepseek-ai\/node-addon-system(?:\/|$)/u, 'node-pty', 'koffi'],
    },
  })
  const require = createRequire(join(root, 'packages/subprocess/subprocess-local/package.json'))
  for (const name of ['node-pty', 'koffi']) {
    const entry = require.resolve(name)
    let directory = dirname(entry)
    while (!existsSync(join(directory, 'package.json'))) directory = dirname(directory)
    await cp(directory, join(output, 'node_modules', name), {
      recursive: true,
      dereference: true,
      filter: path => !/[\\/](?:node_modules|\.git|test|tests|obj)(?:[\\/]|$)/u.test(path.slice(directory.length + 1)),
    })
  }
  await cp(
    join(root, 'packages/fs/tool-fs-search/node_modules/@vscode/ripgrep/package.json'),
    join(output, 'ripgrep-package.json'),
  )
  const nativeEntry = join(root, 'native/system/packages/entry')
  const destination = join(output, 'node_modules/@deepseek-ai/node-addon-system')
  await mkdir(destination, { recursive: true })
  await cp(join(nativeEntry, 'package.json'), join(destination, 'package.json'))
  await cp(join(nativeEntry, 'lib'), join(destination, 'lib'), { recursive: true })
  for (const target of ['linux-x64', 'linux-arm64']) {
    const source = join(root, 'native/system/packages', target)
    if (existsSync(join(source, 'bin')))
      await cp(source, join(output, 'node_modules/@deepseek-ai', `node-addon-system-${target}`), {
        recursive: true,
        dereference: true,
      })
  }
  const koffiRoot = dirname(require.resolve('koffi'))
  const koffiRequire = createRequire(join(koffiRoot, 'package.json'))
  try {
    const binary = koffiRequire.resolve('@koromix/koffi-linux-x64/package.json')
    await cp(dirname(binary), join(output, 'node_modules/@koromix/koffi-linux-x64'), { recursive: true })
  } catch (_unavailableOnBuildHost) {
    /* Other native targets are added from verified npm archives by the installer. */
  }
  for (const [name, exportName, file] of [
    ['dsh-subprocess-local', 'runner', 'runner.mjs'],
    ['dsh-sandbox-windows-acl', 'runner', 'acl-runner.mjs'],
  ] as const) {
    const directory = join(output, 'node_modules/@deepseek-ai', name)
    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({ name: `@deepseek-ai/${name}`, type: 'module', exports: { [`./${exportName}`]: `./${file}` } }),
    )
    await writeFile(
      join(directory, file),
      name === 'dsh-subprocess-local'
        ? "import { runSelectedSubprocessRunner } from '../../../lib/runner.mjs';\nconst selection = process.env.DSH_SUBPROCESS_RUNNER;\ndelete process.env.DSH_SUBPROCESS_RUNNER;\nif (selection === undefined) process.exitCode = 127; else void runSelectedSubprocessRunner(selection);\n"
        : `import '../../../lib/${file}';\n`,
    )
  }
  await writeFile(
    join(output, 'launch.cjs'),
    "const fs=require('node:fs');const path=require('node:path');const cp=require('node:child_process');const log=fs.openSync(path.join(__dirname,'runtime.log'),'a',0o600);const child=cp.spawn(process.execPath,['--disable-sigusr1',path.join(__dirname,'lib/server.mjs')],{cwd:__dirname,detached:true,stdio:['ignore',log,log]});child.on('error',error=>fs.appendFileSync(path.join(__dirname,'runtime.log'),String(error)+'\\n'));child.unref();fs.closeSync(log);\n",
  )
  const licenses = join(output, 'LICENSES')
  await mkdir(licenses, { recursive: true })
  await cp(join(root, 'LICENSE'), join(licenses, 'deepseek-harness.txt'))
  await cp(join(root, 'THIRD_PARTY_NOTICES.md'), join(licenses, 'THIRD_PARTY_NOTICES.md'))
  await cp(join(root, 'native/system/LICENSE'), join(licenses, 'node-addon-system.txt'))
  // Package license files also travel with each copied native dependency.
  await writeFile(
    join(output, 'package.json'),
    `${JSON.stringify({ name: 'dsh-remote-execution', version: '0.2.2-alpha.2', private: true, type: 'module' })}\n`,
  )
  const manifest: unknown = JSON.parse(await readFile(join(root, 'packages/ssh/remote-work/package.json'), 'utf8'))
  await writeFile(join(licenses, 'runtime-package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  const files: { path: string; sha256: string }[] = []
  const collect = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = `${prefix}${entry.name}`
      if (path === 'payload.json') continue
      if (entry.isDirectory()) await collect(join(directory, entry.name), `${path}/`)
      else if (entry.isFile())
        files.push({
          path,
          sha256: createHash('sha256')
            .update(await readFile(join(directory, entry.name)))
            .digest('hex'),
        })
    }
  }
  await collect(output, '')
  await writeFile(join(output, 'payload.json'), `${JSON.stringify(files)}\n`)
}

if (import.meta.main) await buildRemoteWorkRuntime(resolve(import.meta.dirname, '..'))
