/** Keyless provider for the real Web composition; execution and persistence remain production services. */
import type { Context } from '@deepseek-ai/cordis'
import schema from '@deepseek-ai/schemastery'
import {
  LlmAdapter,
  ToolCallId,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'

/** Target OS used by the real SSH test composition. */
export interface Config {
  remotePlatform: 'linux' | 'win32'
}

class RemoteWorkAdapter extends LlmAdapter {
  private readonly platform: Config['remotePlatform']
  constructor(platform: Config['remotePlatform']) {
    super()
    this.platform = platform
  }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve([{ provider, id: 'scripted', name: 'Remote work test' }])
  }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const completed = options.messages.filter(message => message.role === 'tool').length
    const shell = this.platform === 'win32' ? 'pwsh' : 'bash'
    const wrongShell = this.platform === 'win32' ? 'bash' : 'pwsh'
    if (!options.tools?.some(tool => tool.name === shell)) throw new Error(`Execution shell ${shell} was not selected`)
    if (options.tools.some(tool => tool.name === wrongShell))
      throw new Error(`The opposite-platform shell ${wrongShell} was exposed`)
    if (options.messages.some(message => message.role === 'tool' && message.isError))
      throw new Error('The remote workflow returned a failed tool result')
    if (completed >= 3) {
      const text = `Agent host platform: ${process.platform}. Remote workflow completed.`
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const name = completed === 0 ? 'read' : completed === 1 ? 'write' : shell
    const args =
      completed === 0
        ? { file_path: 'runtime-result.txt' }
        : completed === 1
          ? { file_path: 'runtime-result.txt', content: 'remote-runtime-file\n' }
          : {
            description: 'Write a file through the execution shell and report its directory.',
            command:
                this.platform === 'win32'
                  ? "Set-Content -LiteralPath 'runtime-command.txt' -Value 'remote-command-ok' -Encoding UTF8; Write-Output 'REMOTE_WORK_WINDOWS'; Get-Location"
                  : "printf 'remote-command-ok\\n' > runtime-command.txt; printf 'REMOTE_WORK_LINUX\\n'; pwd",
          }
    const id = ToolCallId(`remote-work-test-${completed}`)
    const argumentsText = JSON.stringify(args)
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsText }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsText } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

export const name = 'remote-work-test-llm'
export const inject = ['llm']
/** Test-only target operating system. */
export const Config = schema.object({ remotePlatform: schema.union(['linux', 'win32']).required() })
/** Register the scripted model adapter. @param ctx - real Host services. @param config - target OS. */
export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => ctx.llm.registerAdapter(['remote-work-test'], new RemoteWorkAdapter(config.remotePlatform)))
}
