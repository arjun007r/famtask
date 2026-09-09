/**
 * Agent role 2 of 2: turn a ranked candidate set into the digest a person
 * actually reads.
 *
 * The deterministic ranker in core/priority.ts does the heavy lifting and is
 * always correct on its own terms. This agent only gets to reorder within the
 * candidate set and write the opening line -- so an API outage degrades the
 * digest's tone, never its contents.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { structuredCall } from './client.ts';
import type { TaskView } from '../core/types.ts';
import { firstName } from '../channel/format.ts';

export interface DigestPlan {
  intro: string;
  /** Task ids in the order to show them. */
  order: string[];
}

const TOOL_SCHEMA: Anthropic.Tool.InputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['intro', 'order'],
  properties: {
    intro: {
      type: 'string',
      description: 'One short, warm sentence. No emoji spam, no exclamation stacking.',
    },
    order: {
      type: 'array',
      description: 'Every supplied task id, most important first. No additions, no omissions.',
      items: { type: 'string' },
    },
  },
};

const SYSTEM = `You write a short daily task digest for one member of a family.

You are given tasks already ranked by an algorithm. Reorder only where the
algorithm clearly got it wrong -- a hard deadline today outranks a vague
high-priority item, and something blocking another person outranks solo work.
Otherwise keep the order you were given.

The intro is one sentence, plain and human, in the second person. Mention the
single most pressing thing if there is one. Do not list the tasks; they are
printed below your line. Do not invent tasks, deadlines, or people.

Return every task id you were given, exactly once.`;

export async function planDigest(
  client: Anthropic,
  memberName: string,
  tasks: TaskView[],
  opts: { today: string; model?: string } = { today: new Date().toISOString().slice(0, 10) },
): Promise<DigestPlan | null> {
  if (tasks.length === 0) return null;

  const input = [
    `Today: ${opts.today}`,
    `Reader: ${firstName(memberName)}`,
    '',
    'Tasks, in algorithmic order:',
    ...tasks.map(
      (t) =>
        `- id=${t.id} | ${t.title} | list=${t.list_name} | state=${t.state} | priority=${t.priority} | due=${t.due_at ?? 'none'}`,
    ),
  ].join('\n');

  const plan = await structuredCall<DigestPlan>(client, {
    system: SYSTEM,
    input,
    effort: 'low',
    model: opts.model,
    tool: {
      name: 'write_digest',
      description: 'Provide the digest intro line and the final task order.',
      input_schema: TOOL_SCHEMA,
    },
  });

  return plan ? sanitize(plan, tasks) : null;
}

/** The agent may only permute the set it was handed. Anything it adds or
 *  drops is discarded rather than trusted. */
export function sanitize(plan: DigestPlan, tasks: TaskView[]): DigestPlan {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const seen = new Set<string>();
  const order: string[] = [];
  for (const id of plan.order ?? []) {
    if (byId.has(id) && !seen.has(id)) {
      seen.add(id);
      order.push(id);
    }
  }
  for (const t of tasks) if (!seen.has(t.id)) order.push(t.id);
  return { intro: (plan.intro ?? '').trim().slice(0, 240), order };
}

export function applyPlan(tasks: TaskView[], plan: DigestPlan): TaskView[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return plan.order.map((id) => byId.get(id)).filter((t): t is TaskView => Boolean(t));
}
