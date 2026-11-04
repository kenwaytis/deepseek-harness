/** Private execution-only carrier; no Agent, model adapter, or credential provider runs here. */
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { RemoteExecutionServer } from './runtime-server.ts'

async function main(): Promise<void> {
  const root = dirname(dirname(fileURLToPath(import.meta.url)))
  const input: unknown = JSON.parse(await readFile(join(root, 'runtime.json'), 'utf8'))
  const config = z
    .object({
      authorizedKey: z.string().min(1).max(256),
      version: z.string(),
      maxProcesses: z.number().int().positive(),
      maxOutputBytes: z.number().int().positive(),
      readChunkBytes: z.number().int().positive(),
      maxRememberedOperations: z.number().int().positive(),
      maxFrameBytes: z.number().int().positive(),
      authenticationTimeoutMs: z.number().int().positive(),
      maxConnections: z.number().int().positive(),
    })
    .strict()
    .parse(input)
  const server = new RemoteExecutionServer({ root, ...config })
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void server.close().then(
        () => {
          process.exitCode = 0
        },
        (error: unknown) => {
          console.error(error)
          process.exitCode = 1
        },
      )
    })
  }
  try {
    await server.start()
  } catch (error) {
    try {
      await server.close()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Remote Runtime startup and cleanup failed')
    }
    throw error
  }
}
void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
