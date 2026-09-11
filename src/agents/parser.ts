/**
 * Agent role 1 of 2: turn a chat message into a structured intent.
 *
 * It classifies and extracts only. It never touches the database -- the
 * caller (src/core/services/inbox.ts) decides what to do with the result,
 * which keeps this replayable and testable against fixtures.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { structuredCall } from './client.ts';
import type { Priority, TaskState } from '../core/types.ts';

export type Intent =
  | 'new_task'
  | 'status_update'
  | 'reassignment'
  | 'clarification'
  | 'comment'
  | 'query'
  | 'chitchat';

export interface ParsedTask {
  title: string;
  description?: string | null;
  list?: string | null;
  assignee?: string | null;
  priority?: Priority | null;
  due_date?: string | null;
}

export interface ParsedQuery {
  scope: 'mine' | 'member' | 'list' | 'unclaimed' | 'next';
  member?: string | null;
  list?: string | null;
  search?: string | null;
}

export interface ParsedMessage {
  intent: Intent;
  /** YYYY-MM-DD, when the message moves an existing task's deadline. */
  new_due_date?: string | null;
  tasks?: ParsedTask[];
  /** Free text naming the task an update refers to; matched by the caller. */
  target_task_hint?: string | null;
  new_state?: TaskState | null;
  new_assignee?: string | null;
  comment?: string | null;
  query?: ParsedQuery | null;
  confidence: number;
}

export interface ParseContext {
  speakerName: string;
  /** 'dm' or 'group' -- group messages are chattier and need a higher bar. */
  chatType: 'dm' | 'group';
  memberNames: string[];
  listNames: string[];
  /** Open tasks the update might refer to: "title [list] — assignee". */
  openTasks: string[];
  /** ISO date, so relative due dates resolve correctly. */
  today: string;
}

/**
 * Under `strict: true` a property that is not in `required` is never emitted
 * — the compiled schema simply does not allow it. So every property is
 * required, and "optional" is expressed as anyOf-with-null. Type arrays
 * (`type: ["string", "null"]`) are rejected outright; anyOf is the union
 * mechanism strict tool use supports.
 */
const nullable = (schema: Record<string, unknown>, description: string) => ({
  anyOf: [schema, { type: 'null' }],
  description,
});

const TASK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'description', 'list', 'assignee', 'priority', 'due_date'],
  properties: {
    title: { type: 'string', description: 'Short imperative title.' },
    description: nullable({ type: 'string' }, 'Extra detail, or null.'),
    list: nullable(
      { type: 'string' },
      'An existing list name if one clearly fits, otherwise a new one, or null if unsure.',
    ),
    assignee: nullable(
      { type: 'string' },
      'A family member name, or "group" if it is for whoever picks it up, or null if unclear.',
    ),
    priority: nullable({ type: 'string', enum: ['high', 'medium', 'low'] }, 'Or null.'),
    due_date: nullable({ type: 'string' }, 'YYYY-MM-DD resolved from today, or null.'),
  },
};

const QUERY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['scope', 'member', 'list', 'search'],
  properties: {
    scope: { type: 'string', enum: ['mine', 'member', 'list', 'unclaimed', 'next'] },
    member: nullable({ type: 'string' }, 'Whose tasks, for scope=member.'),
    list: nullable({ type: 'string' }, 'Which list, for scope=list.'),
    search: nullable({ type: 'string' }, 'Words to filter by, or null.'),
  },
};

export const TOOL_SCHEMA: Anthropic.Tool.InputSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'intent',
    'confidence',
    'tasks',
    'target_task_hint',
    'new_state',
    'new_due_date',
    'new_assignee',
    'comment',
    'query',
  ],
  properties: {
    intent: {
      type: 'string',
      enum: [
        'new_task',
        'status_update',
        'reassignment',
        'clarification',
        'comment',
        'query',
        'chitchat',
      ],
      description: 'What this message is doing.',
    },
    confidence: {
      type: 'number',
      description: '0 to 1. Below 0.5 the caller ignores the message.',
    },
    tasks: nullable(
      { type: 'array', items: TASK_SCHEMA },
      'Tasks to create. Required when intent is new_task — at least one, never empty. Null otherwise.',
    ),
    target_task_hint: nullable(
      { type: 'string' },
      'Words identifying the existing task being updated or discussed, or null.',
    ),
    new_state: nullable(
      {
        type: 'string',
        enum: ['todo', 'in_progress', 'blocked', 'needs_clarification', 'done', 'cancelled'],
      },
      'The state the message moves an existing task to, or null.',
    ),
    new_due_date: nullable(
      { type: 'string' },
      'YYYY-MM-DD when the message moves an existing task\'s deadline, or null.',
    ),
    new_assignee: nullable(
      { type: 'string' },
      'A family member name; "group" when it is thrown open to the family for ' +
        'whoever picks it up ("someone else grab it"); "unassigned" only when it ' +
        'should explicitly belong to nobody. Only for intent=reassignment, else null.',
    ),
    comment: nullable(
      { type: 'string' },
      'Text to append to the task thread, or null.',
    ),
    query: nullable(QUERY_SCHEMA, 'Only for intent=query. Null otherwise.'),
  },
};

const SYSTEM = `You classify messages in a family's chat and extract task data.
Reply by calling the record_message tool exactly once. Never reply with prose.

Intents:
- new_task: someone is asking for something to get done, or noting something that must happen.
- status_update: progress on an existing task ("done", "started that", "stuck on the permit").
- reassignment: handing an existing task to someone else, or throwing it open to the family.
- clarification: a question about an existing task, or an answer to one.
- comment: extra context on an existing task that is not a status change.
- query: asking what to do ("what are my tasks", "what's next", "show the business list").
- chitchat: everything else. Ordinary conversation, jokes, logistics with no task in it.

Rules:
- If intent is new_task you MUST fill in tasks with at least one entry. An
  empty tasks array with intent new_task is never correct.
- Prefer chitchat when unsure. A missed task is recoverable; a chat log full of
  junk tasks is not. In a group chat especially, only pull out a task when
  someone is clearly asking for something to be done.
- One message can contain several new tasks. Split them.
- Only use a list name from the known lists unless the message clearly names a
  new one. Leave list null rather than guessing.
- Only use assignee names from the known family members. Use "group" when the
  message is addressed to everyone or to no one in particular.
- Resolve relative dates ("tomorrow", "Friday") against today's date.
- Moving a deadline on an existing task is a status_update or comment with
  new_due_date set — not a new task.
- Set priority high only for genuine urgency, not politeness ("please" is not urgent).`;

export async function parseMessage(
  client: Anthropic,
  text: string,
  ctx: ParseContext,
  model?: string,
): Promise<ParsedMessage | null> {
  const input = [
    `Today: ${ctx.today}`,
    `Chat: ${ctx.chatType}`,
    `Speaker: ${ctx.speakerName}`,
    `Family members: ${ctx.memberNames.join(', ') || '(none)'}`,
    `Known lists: ${ctx.listNames.join(', ') || '(none)'}`,
    ctx.openTasks.length > 0
      ? `Open tasks:\n${ctx.openTasks.map((t) => `- ${t}`).join('\n')}`
      : 'Open tasks: (none)',
    '',
    'Message:',
    text,
  ].join('\n');

  return structuredCall<ParsedMessage>(client, {
    system: SYSTEM,
    input,
    effort: 'low',
    model,
    tool: {
      name: 'record_message',
      description: 'Record the classification and extracted fields for this chat message.',
      input_schema: TOOL_SCHEMA,
    },
  });
}
