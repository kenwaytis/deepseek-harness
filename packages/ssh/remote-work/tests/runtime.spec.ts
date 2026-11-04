/** Runtime transport loss must not own process lifetime or replay uncertain mutations. */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnection } from 'node:net'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { SshRpcPeer } from '@deepseek-ai/dsh-ssh/protocol'
import { authenticateRuntimeClient, createRuntimeIdentity, RemoteRuntimeIdentityError } from '../src/authentication.ts'
import { RemoteExecutionServer, type RuntimeConfig } from '../src/runtime-server.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

async function fixture(options: Partial<RuntimeConfig> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-remote-runtime-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const identity = createRuntimeIdentity()
  const privateKey = identity.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const runtime = new RemoteExecutionServer({
    root,
    authorizedKey: identity.publicKey,
    version: 'test',
    maxProcesses: 8,
    maxOutputBytes: 64 * 1024,
    readChunkBytes: 64 * 1024,
    maxRememberedOperations: 8,
    maxFrameBytes: 1024 * 1024,
    authenticationTimeoutMs: 10_000,
    maxConnections: 8,
    ...options,
  })
  cleanup.push(() => runtime.close())
  const port = await runtime.start()
  const connect = async (secret = privateKey, serverKey = runtime.publicKey) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    await once(socket, 'connect')
    await authenticateRuntimeClient(socket, secret, serverKey, AbortSignal.timeout(10_000))
    const peer = new SshRpcPeer(socket, socket, 1024 * 1024, 16)
    cleanup.push(async () => {
      if (!socket.closed) {
        const closed = once(socket, 'close')
        peer.close()
        await closed
      }
    })
    await peer.request('hello', { protocol: 1, version: 'test' }, z.unknown())
    return peer
  }
  return { root, connect }
}

const processResult = z.looseObject({
  output: z.looseObject({ stdout: z.looseObject({ data: z.base64() }) }),
  outcome: z.looseObject({ exitCode: z.number().nullable() }).nullable(),
  error: z.string().nullable(),
})

async function observe(peer: SshRpcPeer, id: string) {
  const result = await peer.request('observe', { method: 'process.read', params: { id, offsets: {} } }, processResult)
  return { ...result, stdout: Buffer.from(result.output.stdout.data, 'base64').toString('utf8') }
}

describe('remote execution daemon', () => {
  it('keeps a running process through transport loss and exposes its original output after reattachment', async () => {
    const { root, connect } = await fixture()
    const first = await connect()
    const id = randomUUID()
    const release = join(root, 'release')
    const script =
      "const fs=require('node:fs'); const stop=()=>{if(fs.existsSync(process.argv[1])){ console.log('finished');process.exit(0)}}; fs.watch(process.argv[2],stop);console.log('started');stop()"
    await first.request(
      'execute',
      {
        id: randomUUID(),
        method: 'process.start',
        params: {
          id,
          spec: {
            argv: [process.execPath, '-e', script, release, root],
            cwd: root,
            graceMs: 1000,
            stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
          },
        },
      },
      z.unknown(),
    )
    await expect.poll(async () => (await observe(first, id)).stdout).toContain('started')
    first.close()
    await writeFile(release, 'continue')
    const second = await connect()
    await expect.poll(async () => (await observe(second, id)).outcome?.exitCode).toBe(0)
    expect((await observe(second, id)).stdout).toBe('started\nfinished\n')
  })

  it('recovers the committed result instead of performing a mutation twice', async () => {
    const { root, connect } = await fixture()
    const peer = await connect()
    const path = join(root, 'created.txt')
    const resolve = await peer.request(
      'observe',
      { method: 'fs.resolve', params: { path } },
      z.object({ targetKey: z.string(), displayPath: z.string() }).strict(),
    )
    const id = randomUUID()
    const request = {
      id,
      method: 'fs.write',
      params: {
        target: resolve,
        content: 'once',
        expected: { kind: 'createIfAbsent' },
        policy: { mode: 'workspace-write', workspaceRoot: root },
      },
    }
    const result = await peer.request('execute', request, z.unknown())
    peer.close()
    const second = await connect()
    expect(await second.request('recover', { id }, z.unknown())).toEqual({ kind: 'completed', value: result })
    expect(await second.request('execute', request, z.unknown())).toEqual(result)
    expect(await readFile(path, 'utf8')).toBe('once')
  })

  it('pages process bytes without corrupting multibyte text or binary output', async () => {
    const { root, connect } = await fixture({ readChunkBytes: 3 })
    const peer = await connect()
    const id = randomUUID()
    const expected = Buffer.concat([Buffer.from('远程🙂'), Buffer.from([0, 255, 254, 127])])
    await peer.request(
      'execute',
      {
        id: randomUUID(),
        method: 'process.start',
        params: {
          id,
          spec: {
            argv: [
              process.execPath,
              '-e',
              `process.stdout.write(Buffer.from('${expected.toString('base64')}', 'base64'))`,
            ],
            cwd: root,
            graceMs: 1000,
            stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
          },
        },
      },
      z.unknown(),
    )
    await expect.poll(async () => (await observe(peer, id)).outcome?.exitCode).toBe(0)
    const chunks: Buffer[] = []
    let offset = 0
    const frameSchema = z
      .object({
        complete: z.boolean(),
        output: z
          .object({ stdout: z.object({ data: z.base64(), nextOffset: z.number(), lossy: z.boolean() }) })
          .loose(),
      })
      .loose()
    while (true) {
      const frame = await peer.request(
        'observe',
        { method: 'process.read', params: { id, offsets: { stdout: offset } } },
        frameSchema,
      )
      const bytes = Buffer.from(frame.output.stdout.data, 'base64')
      expect(bytes.length).toBeLessThanOrEqual(3)
      expect(frame.output.stdout.lossy).toBe(false)
      chunks.push(bytes)
      offset = frame.output.stdout.nextOffset
      if (frame.complete) break
    }
    expect(Buffer.concat(chunks)).toEqual(expected)
    expect(offset).toBe(expected.length)
  })

  it('reports an oversized result without breaking the transport or retrying forever', async () => {
    const { root, connect } = await fixture()
    const peer = await connect()
    const path = join(root, 'large.bin')
    await writeFile(path, Buffer.alloc(1024 * 1024))
    const target = await peer.request('observe', { method: 'fs.resolve', params: { path } }, z.unknown())
    await expect(
      peer.request('observe', { method: 'fs.readBytes', params: { target, maxBytes: 2 * 1024 * 1024 } }, z.unknown()),
    ).rejects.toMatchObject({ code: 'REMOTE_RESULT_TOO_LARGE' })
    expect(await peer.request('observe', { method: 'fs.stat', params: { target } }, z.unknown())).toMatchObject({
      type: 'file',
      size: 1024 * 1024,
    })
  })

  it('enforces the remote file policy outside the workspace and platform temp roots', async () => {
    const outside = await mkdtemp(join(homedir(), '.dsh-remote-policy-'))
    cleanup.push(() => rm(outside, { recursive: true, force: true }))
    const { root, connect } = await fixture()
    const peer = await connect()
    const target = await peer.request(
      'observe',
      { method: 'fs.resolve', params: { path: join(outside, 'forbidden.txt') } },
      z.unknown(),
    )
    await expect(
      peer.request(
        'execute',
        {
          id: randomUUID(),
          method: 'fs.write',
          params: {
            target,
            content: 'must not publish',
            policy: { mode: 'workspace-write', workspaceRoot: root },
          },
        },
        z.unknown(),
      ),
    ).rejects.toMatchObject({ code: 'FS_SANDBOX_DENIED' })
    await expect(readFile(join(outside, 'forbidden.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('requires the Host private key and refuses mutations on the observation channel', async () => {
    const { root, connect } = await fixture()
    const other = createRuntimeIdentity()
    await expect(connect(other.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString())).rejects.toBeInstanceOf(
      RemoteRuntimeIdentityError,
    )
    const peer = await connect()
    await expect(peer.request('observe', { method: 'fs.write', params: {} }, z.unknown())).rejects.toThrow(
      'cannot mutate',
    )
    const endpoint: unknown = JSON.parse(await readFile(join(root, 'endpoint.json'), 'utf8'))
    expect(z.object({ publicKey: z.base64(), port: z.number() }).loose().safeParse(endpoint).success).toBe(true)
    expect(JSON.stringify(endpoint)).not.toContain('PRIVATE KEY')
  })

  it('refuses an endpoint that does not own the public key read over SSH', async () => {
    const { connect } = await fixture()
    await expect(connect(undefined, createRuntimeIdentity().publicKey)).rejects.toBeInstanceOf(
      RemoteRuntimeIdentityError,
    )
    const peer = await connect()
    expect(await peer.request('observe', { method: 'terminal.environment', params: {} }, z.unknown())).toBeDefined()
  })
})
