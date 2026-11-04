/** A directory identifies both the execution computer and its native absolute path. */
import { describe, expect, it } from 'vitest'
import { remoteDirectory, remoteDirectoryOf, workspaceTitleOf } from '../src/index.ts'

const computer = 'e7250a7e-8bdf-4a6f-942c-cb3e2cdb0b02'

describe('computer-qualified directory identities', () => {
  it.each(['/home/user/a folder', 'C:\\work\\项目', '\\\\server\\share\\project', '/tmp/percent%#?'])(
    'round-trips %s without applying the local OS path rules',
    (path) => {
      const value = remoteDirectory(computer, path)
      expect(remoteDirectoryOf(value)).toEqual({ computerId: computer, path })
      expect(value).not.toContain(path)
    },
  )

  it('keeps identical directory spellings on different computers distinct', () => {
    expect(remoteDirectory(computer, '/work')).not.toBe(
      remoteDirectory('fa047abc-62dd-4118-a0ec-47b1a67f3131', '/work'),
    )
    expect(workspaceTitleOf(remoteDirectory(computer, 'C:\\work\\project'))).toBe('project')
  })

  it.each(['relative', '', '/tmp/\0bad'])('rejects an invalid native directory %j', (path) => {
    expect(() => remoteDirectory(computer, path)).toThrow('Invalid remote')
  })

  it.each([
    '/local/path',
    'dsh-ssh://not-a-uuid/%2Fwork',
    `dsh-ssh://${computer}/%zz`,
    `dsh-ssh://${computer}/%2fwork`,
    `dsh-ssh://${computer}/relative`,
    `dsh-ssh://${computer}/%00`,
    `dsh-ssh://${computer}/%2Fwork?query`,
    `dsh-ssh://${computer}/%2Fwork#fragment`,
  ])('does not decode a local or malformed identity %s', (value) => {
    expect(remoteDirectoryOf(value)).toBeUndefined()
  })
})
