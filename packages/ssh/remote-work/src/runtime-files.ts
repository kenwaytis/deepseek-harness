/** Validated filesystem RPC over the same atomic and sandboxed provider used locally. */
import type { Context } from '@deepseek-ai/cordis'
import { FsVersion } from '@deepseek-ai/dsh-fs'
import type { FsTarget, FsWriteIntent } from '@deepseek-ai/dsh-fs'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import { z } from 'zod'
import {
  editSchema,
  hunkSchema,
  intentSchema,
  moveOptionsSchema,
  policySchema,
  targetSchema,
  versionGuardSchema,
} from '@deepseek-ai/dsh-ssh/schemas'

const target = targetSchema.transform(value => value as FsTarget)
const policy = policySchema.transform(
  (value): SandboxExecutionPolicy => ({
    mode: value.mode,
    workspaceRoot: value.workspaceRoot,
    ...(value.additionalWritableRoots === undefined ? {} : { additionalWritableRoots: value.additionalWritableRoots }),
    ...(value.sessionId === undefined ? {} : { sessionId: SessionId(value.sessionId) }),
  }),
)
const guard = versionGuardSchema.transform(value => ({ version: FsVersion(value.version) })).optional()
const intent = intentSchema.transform(value => value as FsWriteIntent).optional()

/**
 * Dispatch one filesystem operation; all paths are resolved on the remote computer.
 * @param ctx - remote filesystem and subprocess services.
 * @param method - private operation identifier.
 * @param raw - untrusted RPC parameters.
 * @param signal - runtime shutdown or request cancellation.
 * @returns the JSON-compatible provider result.
 */
export async function runtimeFileOperation(
  ctx: Context,
  method: string,
  raw: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  const fs = ctx.fs
  switch (method) {
    case 'fs.resolve': {
      const input = z.object({ path: z.string(), cwd: z.string().optional() }).strict().parse(raw)
      return fs.resolve(input.path, { ...(input.cwd === undefined ? {} : { cwd: input.cwd }), signal })
    }
    case 'fs.lstat': {
      const input = z.object({ path: z.string(), cwd: z.string().optional() }).strict().parse(raw)
      return (await fs.lstat(input.path, input.cwd === undefined ? undefined : { cwd: input.cwd }, signal)) ?? null
    }
    case 'fs.stat':
    case 'fs.list':
    case 'fs.readText': {
      const input = z.object({ target }).strict().parse(raw)
      if (method === 'fs.stat') return (await fs.stat(input.target, signal)) ?? null
      if (method === 'fs.list') return fs.listDir(input.target, signal)
      let text = ''
      let bytes = 0
      for await (const chunk of await fs.streamText(input.target, signal)) {
        bytes += Buffer.byteLength(chunk)
        if (bytes > 8 * 1024 * 1024)
          throw new Error('Whole-text transfer exceeds its frame budget; read a byte range instead')
        text += chunk
      }
      return text
    }
    case 'fs.readBytes': {
      const input = z.object({ target, maxBytes: z.number().int().nonnegative() }).strict().parse(raw)
      return Buffer.from(await fs.readBytes(input.target, signal, Math.min(input.maxBytes, 8 * 1024 * 1024))).toString(
        'base64',
      )
    }
    case 'fs.readRange': {
      const input = z
        .object({
          target,
          offset: z.number().int().nonnegative(),
          length: z
            .number()
            .int()
            .nonnegative()
            .max(8 * 1024 * 1024),
        })
        .strict()
        .parse(raw)
      return Buffer.from(await fs.readByteRange(input.target, input, signal)).toString('base64')
    }
    case 'fs.write': {
      const input = z.object({ target, content: z.string(), expected: intent, policy }).strict().parse(raw)
      return fs.writeText(input.target, input.content, input.expected, signal, input.policy)
    }
    case 'fs.edit': {
      const input = z.object({ target, edit: editSchema, expected: guard, policy }).strict().parse(raw)
      return fs.editText(input.target, input.edit, input.expected, signal, input.policy)
    }
    case 'fs.patch': {
      const input = z
        .object({ target, hunks: z.array(hunkSchema), expected: guard, policy })
        .strict()
        .parse(raw)
      return fs.patchText(input.target, input.hunks, input.expected, signal, input.policy)
    }
    case 'fs.delete': {
      const input = z.object({ target, expected: guard, policy }).strict().parse(raw)
      return fs.deleteFile(input.target, input.expected, signal, input.policy)
    }
    case 'fs.move': {
      const input = z
        .object({ source: target, destination: target, options: moveOptionsSchema, policy })
        .strict()
        .parse(raw)
      return fs.moveFile(
        input.source,
        input.destination,
        {
          ...(input.options.hunks === undefined ? {} : { hunks: input.options.hunks }),
          ...(input.options.expectedSource === undefined
            ? {}
            : { expectedSource: { version: FsVersion(input.options.expectedSource.version) } }),
          ...(input.options.expectedDestination === undefined
            ? {}
            : { expectedDestination: input.options.expectedDestination as FsWriteIntent }),
        },
        signal,
        input.policy,
      )
    }
    default:
      throw new Error(`Unknown remote filesystem operation: ${method}`)
  }
}
