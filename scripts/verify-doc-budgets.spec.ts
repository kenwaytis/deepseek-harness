/** Regression tests for standing-document ceilings through the actual gate command. */
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const manifest = JSON.parse(readFileSync(join(import.meta.dirname, 'doc-budgets.manifest.json'), 'utf8')) as Record<string, number | null>

function runGate(
  files: Record<string, string>,
  budgets: Record<string, unknown> = manifest,
  args: string[] = [],
): ReturnType<typeof spawnSync> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-doc-budgets-'))
  try {
    mkdirSync(join(root, 'scripts'))
    writeFileSync(join(root, 'package.json'), '{"type":"module"}\n')
    copyFileSync(join(import.meta.dirname, 'verify-doc-budgets.ts'), join(root, 'scripts/verify-doc-budgets.ts'))
    writeFileSync(join(root, 'scripts/doc-budgets.manifest.json'), JSON.stringify(budgets))
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), text)
    }
    const result = spawnSync(process.execPath, [join(root, 'scripts/verify-doc-budgets.ts'), ...args], { encoding: 'utf8' })
    expect(result.error).toBeUndefined()
    expect(result.signal).toBeNull()
    return result
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function standingDocs(): Record<string, string> {
  return Object.fromEntries(Object.keys(manifest).map(path => [path, 'word\n']))
}

describe('documentation budgets', () => {
  it('requires root AGENTS.md without imposing a word ceiling', () => {
    expect(manifest['AGENTS.md']).toBeNull()
    const result = runGate({ ...standingDocs(), 'AGENTS.md': 'word '.repeat(100_000) })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('all configured ceilings satisfied')
  })

  it('still rejects a missing root AGENTS.md', () => {
    const files = standingDocs()
    delete files['AGENTS.md']
    const result = runGate(files)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('AGENTS.md: budgeted file does not exist')
  })

  it('keeps every other standing document budgeted and rejects excess words', () => {
    for (const [path, ceiling] of Object.entries(manifest)) {
      if (path === 'AGENTS.md') continue
      expect(ceiling, path).toBeTypeOf('number')
      if (ceiling === null) throw new Error(`${path}: expected a word ceiling`)
      const result = runGate({ ...standingDocs(), [path]: 'word '.repeat(ceiling + 1) })
      expect(result.status, path).toBe(1)
      expect(result.stderr).toContain(`${path}: ${ceiling + 1} words exceeds the ${ceiling}-word ceiling`)
    }
  })

  it('accepts the exact ceiling and counts whitespace-delimited words', () => {
    const result = runGate({ 'doc.md': '  one\ttwo\nthree  \n' }, { 'doc.md': 3 })
    expect(result.status).toBe(0)
  })

  it('still rejects missing budgeted files and invalid ceilings', () => {
    const missing = runGate({}, { 'doc.md': 3 })
    expect(missing.status).toBe(1)
    expect(missing.stderr).toContain('doc.md: budgeted file does not exist')
    for (const ceiling of [0, -1, 1.5, 'unlimited']) {
      const invalid = runGate({ 'doc.md': 'word' }, { 'doc.md': ceiling })
      expect(invalid.status).toBe(1)
      expect(invalid.stderr).toContain('doc.md: ceiling must be a positive integer')
    }
  })

  it('lists the root exemption alongside numeric budgets without enforcing them', () => {
    const result = runGate({ 'AGENTS.md': 'word '.repeat(10), 'doc.md': 'one two' }, {
      'AGENTS.md': manifest['AGENTS.md'],
      'doc.md': 1,
    }, ['--list'])
    expect(result.status).toBe(0)
    expect(result.stdout).toMatch(/ok\s+— \/ none\s+AGENTS\.md/)
    expect(result.stdout).toMatch(/OVER\s+2 \/ 1\s+doc\.md/)
  })
})
