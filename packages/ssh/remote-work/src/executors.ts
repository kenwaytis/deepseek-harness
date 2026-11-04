/** A remote Agent's isolated sandbox applies confinement on its execution computer. */
import { Context } from '@deepseek-ai/cordis'
import { SandboxProvider, SandboxUnavailableError } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { remoteDirectoryOf } from '@deepseek-ai/dsh-util-workspace-path'
import { z } from 'zod'
import type { ComputerId } from './types.ts'
import type {} from './index.ts'

const confinedSchema = z
  .object({
    argv: z.array(z.string()).min(1),
    enforcement: z.enum(['full', 'partial']),
    denialSignatures: z.array(z.string()),
    runnerFailureRules: z.array(
      z
        .object({
          fatalSignatures: z.array(z.string()),
          allowedExitCodes: z.array(z.number().int()).optional(),
          informationalLines: z.array(z.string()).optional(),
        })
        .strict(),
    ),
  })
  .strict()

/** Sandbox supplied only within one remote Agent's scoped command plugins. */
export class RemoteSandboxProvider extends SandboxProvider {
  static inject = ['remoteWork']
  /** @param ctx - isolated Agent sandbox context. @param config - immutable execution computer. */
  constructor(
    ctx: Context,
    private readonly config: { computerId: ComputerId },
  ) {
    super(ctx)
  }

  override async confine(argv: readonly string[], policy: SandboxPolicy, signal?: AbortSignal): Promise<ConfinedArgv> {
    try {
      const facts = await this.ctx.remoteWork.connection(this.config.computerId).request(
        'sandbox',
        {
          argv,
          policy: {
            ...policy,
            workspaceRoot: remoteDirectoryOf(policy.workspaceRoot)?.path ?? policy.workspaceRoot,
          },
        },
        confinedSchema,
        signal,
        true,
      )
      return {
        ...facts,
        runnerFailureRules: facts.runnerFailureRules.map(rule => ({
          fatalSignatures: rule.fatalSignatures,
          ...(rule.allowedExitCodes === undefined ? {} : { allowedExitCodes: rule.allowedExitCodes }),
          ...(rule.informationalLines === undefined ? {} : { informationalLines: rule.informationalLines }),
        })),
      }
    } catch (error) {
      throw new SandboxUnavailableError(policy.mode, error instanceof Error ? error.message : String(error))
    }
  }
}
