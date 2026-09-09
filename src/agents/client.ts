import Anthropic from '@anthropic-ai/sdk';

export const DEFAULT_MODEL = 'claude-opus-5';

export interface AgentDeps {
  apiKey: string;
  model?: string;
}

export function createClient(deps: AgentDeps): Anthropic {
  return new Anthropic({ apiKey: deps.apiKey });
}

export interface StructuredCallOptions {
  system: string;
  input: string;
  tool: { name: string; description: string; input_schema: Anthropic.Tool.InputSchema };
  model?: string;
  effort?: 'low' | 'medium' | 'high';
  maxTokens?: number;
}

/**
 * One call, one strict-schema tool result. `tool_choice` stays `auto` and the
 * system prompt names the tool, which keeps this compatible with adaptive
 * thinking; callers treat null as "the agent had nothing to say".
 */
export async function structuredCall<T>(
  client: Anthropic,
  opts: StructuredCallOptions,
): Promise<T | null> {
  const response = await client.messages.create({
    model: opts.model ?? DEFAULT_MODEL,
    max_tokens: opts.maxTokens ?? 2048,
    output_config: { effort: opts.effort ?? 'low' },
    system: opts.system,
    tools: [
      {
        name: opts.tool.name,
        description: opts.tool.description,
        input_schema: opts.tool.input_schema,
        strict: true,
      },
    ],
    messages: [{ role: 'user', content: opts.input }],
  });

  if (response.stop_reason === 'refusal') return null;
  for (const block of response.content) {
    if (block.type === 'tool_use' && block.name === opts.tool.name) {
      return block.input as T;
    }
  }
  return null;
}
