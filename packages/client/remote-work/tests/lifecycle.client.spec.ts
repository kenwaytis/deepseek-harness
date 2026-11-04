/** Revocation clears authority synchronously; asynchronous stream cleanup cannot replace a later grant. */
import { Context } from '@deepseek-ai/cordis'
import type { AccessEffect } from '@deepseek-ai/dsh-api-remote-access/client'
import type { ComputerId, ComputerState } from '@deepseek-ai/dsh-remote-work/types'
import { afterEach, expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.ts'

interface Frame {
  value: ComputerState[]
  accept(): void
}

function carrier() {
  let item = Promise.withResolvers<IteratorResult<Frame>>()
  const closeGate = Promise.withResolvers<undefined>()
  const stream = {
    async *[Symbol.asyncIterator]() {
      while (true) {
        const next = await item.promise
        item = Promise.withResolvers<IteratorResult<Frame>>()
        if (next.done) return
        yield next.value
      }
    },
    dispose: vi.fn(async () => {
      item.resolve({ done: true, value: undefined })
      await closeGate.promise
    }),
  }
  return {
    stream,
    send(value: ComputerState[]) {
      item.resolve({ done: false, value: { value, accept() {} } })
    },
    release() {
      closeGate.resolve(undefined)
    },
  }
}

const worlds: { ctx: Context; carriers: ReturnType<typeof carrier>[] }[] = []
afterEach(async () => {
  for (const world of worlds.splice(0)) {
    for (const channel of world.carriers) channel.release()
    await world.ctx.fiber.dispose()
  }
})

function fixture() {
  const ctx = new Context()
  const carriers: ReturnType<typeof carrier>[] = []
  worlds.push({ ctx, carriers })
  let grant: (() => () => void) | undefined
  ctx.provide('remote', {
    $stream: () => {
      const channel = carrier()
      carriers.push(channel)
      return channel.stream
    },
  } as never)
  ctx.provide('remoteAccess', {
    whenAccess(_action: string, callback: () => AccessEffect) {
      grant = () => {
        const effect = callback()
        if (typeof effect !== 'function') throw new Error('Computer access did not return a disposer')
        return effect
      }
      return () => {}
    },
  } as never)
  apply(ctx)
  if (grant === undefined) throw new Error('Computer model did not request access')
  return { ctx, carriers, grant, snapshot: () => ctx.remoteComputers.source.getSnapshot() }
}

function computer(name: string): ComputerState {
  return {
    computer: {
      id: '52a77391-e6bc-48e1-b83e-fdced3a30f02' as ComputerId,
      name,
      host: 'example.test',
      port: 22,
      username: 'test',
      fingerprint: 'SHA256:test',
    },
    status: 'connected',
  }
}

it('clears a revoked list before the old stream finishes cleanup and ignores its pending frame', async () => {
  const f = fixture()
  const revoke = f.grant()
  const first = f.carriers[0]
  if (first === undefined) throw new Error('Missing first carrier')
  first.send([computer('first')])
  await expect.poll(() => f.snapshot().items[0]?.computer.name).toBe('first')
  first.send([computer('late')])
  revoke()
  expect(f.snapshot().items).toEqual([])
  await expect.poll(() => first.stream.dispose.mock.calls.length).toBe(1)
  expect(f.snapshot().items).toEqual([])
  first.release()
})

it('does not clear a new grant when an older carrier finishes closing', async () => {
  const f = fixture()
  const revoke = f.grant()
  const first = f.carriers[0]
  if (first === undefined) throw new Error('Missing first carrier')
  revoke()
  f.grant()
  const second = f.carriers[1]
  if (second === undefined) throw new Error('Missing replacement carrier')
  second.send([computer('replacement')])
  await expect.poll(() => f.snapshot().items[0]?.computer.name).toBe('replacement')
  first.release()
  await first.stream.dispose.mock.results[0]?.value
  expect(f.snapshot().items[0]?.computer.name).toBe('replacement')
  second.release()
})

it('waits for active stream cleanup when its owning fiber is disposed', async () => {
  const f = fixture()
  f.grant()
  const channel = f.carriers[0]
  if (channel === undefined) throw new Error('Missing active carrier')
  let stopped = false
  const closing = f.ctx.fiber.dispose().then(() => {
    stopped = true
  })
  await expect.poll(() => channel.stream.dispose.mock.calls.length).toBe(1)
  expect(stopped).toBe(false)
  channel.release()
  await closing
  expect(stopped).toBe(true)
})
