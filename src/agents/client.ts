import Anthropic from '@anthropic-ai/sdk';

export const DEFAULT_MODEL = 'claude-opus-5';

export interface AgentDeps {
  apiKey: string;
  model?: string;
}

export function createClient(deps: AgentDeps): Anthropic {
  return new Anthropic({ apiKey: deps.apiKey });
}

/**
 * The agent could not be reached at all — no key, no credit, rate limited,
 * upstream down. Distinct from a null result, which means the model ran and
 * had nothing to say. Callers must keep working without the agent rather
 * than failing the whole update: a lapsed API key should not put the bot
 * into a retry loop.
 */
export class AgentUnavailableError extends Error {
  status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'AgentUnavailableError';
    this.status = status;
  }
}

/**
 * What to show a person. The raw API error goes to the logs, not the chat.
 *
 * Classified on `status` and message text rather than `instanceof`: the
 * billing failure has no error class of its own (it is a 400 carrying a
 * message), and `instanceof` silently stops matching when two copies of the
 * SDK end up in the tree. Structural checks keep working in both cases.
 */
export function describeAgentFailure(err: unknown): string {
  const status = errorStatus(err);
  const message = err instanceof Error ? err.message : String(err ?? '');

  if (/credit balance/i.test(message)) return 'the Anthropic account is out of credit';
  if (status === 401) return 'the API key is not valid';
  if (status === 403) return 'the API key lacks access';
  if (status === 429) return 'it is rate limited right now';
  if (status !== undefined && status >= 500) return 'the Anthropic API is having trouble';
  if (/connection|network|fetch failed|ENOTFOUND|ECONNREFUSED/i.test(message)) {
    return 'the Anthropic API is unreachable';
  }
  // A 400 that is not billing means the request itself is wrong -- a schema
  // or parameter bug. The API names the offending field, and that detail is
  // the whole diagnosis, so pass it through rather than swallowing it.
  if (status === 400) return `the API rejected the request: ${apiMessage(message)}`;
  if (status !== undefined) return `the Anthropic API rejected the request (${status})`;
  return 'the agent failed for an unknown reason';
}

/** Pull the human part out of an SDK error string, which wraps the API's
 *  JSON body after the status code. */
function apiMessage(raw: string): string {
  const match = raw.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  const text = match?.[1]?.replace(/\\"/g, '"') ?? raw;
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

function errorStatus(err: unknown): number | undefined {
  const raw = (err as { status?: unknown })?.status;
  return typeof raw === 'number' ? raw : undefined;
}

/**
 * `output_config.effort` is rejected outright by models that do not support
 * it — Haiku 4.5 and Sonnet 4.5 — so sending it unconditionally makes
 * trying a cheaper model fail with a 400 rather than just costing less.
 */
export function supportsEffort(model: string): boolean {
  return !/haiku/i.test(model) && !/sonnet-4-5/i.test(model);
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
  const model = opts.model ?? DEFAULT_MODEL;
  let response;
  try {
    response = await client.messages.create({
      model,
      max_tokens: opts.maxTokens ?? 2048,
      ...(supportsEffort(model) ? { output_config: { effort: opts.effort ?? 'low' } } : {}),
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
  } catch (err) {
    console.error(`agent call ${opts.tool.name} failed`, err);
    throw new AgentUnavailableError(describeAgentFailure(err), errorStatus(err));
  }

  if (response.stop_reason === 'refusal') return null;
  for (const block of response.content) {
    if (block.type === 'tool_use' && block.name === opts.tool.name) {
      return block.input as T;
    }
  }
  return null;
}
