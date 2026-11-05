/** Saved SSH computers reconnect without holding Host startup on external authentication. */
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { afterEach, expect, it, vi } from 'vitest'
import { MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import RemoteWorkService from '../src/index.ts'
import { RemoteConnection } from '../src/connection.ts'
import { SshSession } from '../src/ssh-session.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.restoreAllMocks()
})

async function harness() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend()
  ctx.effect(() => ctx.storage.backend.register('memory', backend))
  ctx.provide(storageBackendServiceKey('memory'), backend)
  await ctx.plugin(StorageDomain, { backend: 'memory' })
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  ctx.provide('tools', {} as Context['tools'])
  ctx.provide('systemPrompt', {} as Context['systemPrompt'])
  ctx.provide('typert', {} as Context['typert'])
  ctx.provide('shell', { sandboxMode: 'workspace-write' } as Context['shell'])
  ctx.provide('sandboxPolicy', { defaultMode: 'workspace-write' } as Context['sandboxPolicy'])
  const fiber = await ctx.plugin(RemoteWorkService)
  const probe = vi.spyOn(SshSession.prototype, 'connect').mockResolvedValue()
  const connection = vi.spyOn(RemoteConnection.prototype, 'connect').mockResolvedValue({
    instance: randomUUID(), platform: 'linux', home: '/home/test', executable: '/private/node', version: 'test',
  })
  const computers = []
  for (const name of ['first', 'second']) {
    const result = await ctx.remoteWork.connectComputer({
      name, host: `${name}.example.test`, port: 22, username: 'test', fingerprint: 'SHA256:test',
    }, new AbortController().signal)
    if (result.kind !== 'connected') throw new Error('Fixture fingerprint was not accepted')
    computers.push(result.computer)
  }
  await fiber.dispose()
  connection.mockRestore()
  probe.mockRestore()
  return { ctx, computers }
}

it('starts all saved connections in the background and exposes failures without failing startup', async () => {
  const { ctx, computers } = await harness()
  const attempt = Promise.withResolvers<undefined>()
  const connect = vi.spyOn(SshSession.prototype, 'connect').mockImplementation(() => attempt.promise)
  await ctx.plugin(RemoteWorkService)
  expect(connect).toHaveBeenCalledTimes(2)
  expect(ctx.remoteWork.list().map(state => state.status)).toEqual(['connecting', 'connecting'])
  expect(ctx.remoteWork.list().map(state => state.computer)).toEqual(computers)
  attempt.reject(new Error('SSH authentication required'))
  await vi.waitFor(() => {
    expect(ctx.remoteWork.list().map(state => ({ status: state.status, error: state.error }))).toEqual([
      { status: 'error', error: 'SSH authentication required' },
      { status: 'error', error: 'SSH authentication required' },
    ])
  })
  expect(connect).toHaveBeenCalledTimes(2)
})

it('cancels and joins startup connections when the plugin unloads', async () => {
  const { ctx } = await harness()
  const settled = vi.fn()
  vi.spyOn(SshSession.prototype, 'connect').mockImplementation(signal => new Promise<void>((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      settled()
      reject(new Error('Startup connection cancelled'))
    }, { once: true })
  }))
  const fiber = await ctx.plugin(RemoteWorkService)
  expect(ctx.remoteWork.list().map(state => state.status)).toEqual(['connecting', 'connecting'])
  await fiber.dispose()
  expect(settled).toHaveBeenCalledTimes(2)
  expect(ctx.get('remoteWork')).toBeUndefined()
})
