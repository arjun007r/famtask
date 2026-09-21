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
  /** Someone outside the family the task hangs on. */
  waiting_on?: string | null;
  priority?: Priority | null;
  due_date?: string | null;
}

export interface ParsedQuery {
  scope: 'mine' | 'member' | 'list' | 'unclaimed' | 'next' | 'waiting' | 'completed';
  /** For scope=completed: how far back to look. */
  period?: 'week' | 'month' | 'quarter' | 'year' | null;
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
  /** A name to start waiting on, or "none" when the outsider came back. */
  new_waiting_on?: string | null;
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
 * required, and "optional" has to be expressed some other way.
 *
 * anyOf-with-null was that way, until the schema outgrew a hard API limit of
 * **16 union-typed parameters** and every parse started failing with a 400.
 * Each optional field cost a union, so the schema could only ever grow to a
 * fixed size before breaking in production rather than in a test.
 *
 * So optional is now the empty string, and an enum carries `''` as a member.
 * No unions, no ceiling, and `normalize()` turns it all back into null on the
 * way in so nothing downstream knows the difference.
 */
const optional = (description: string) => ({
  type: 'string',
  description: `${description} Empty string when it does not apply.`,
});

const optionalEnum = (values: string[], description: string) => ({
  type: 'string',
  enum: [...values, ''],
  description: `${description} Empty string when it does not apply.`,
});

const TASK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'description', 'list', 'assignee', 'waiting_on', 'priority', 'due_date'],
  properties: {
    title: { type: 'string', description: 'Short imperative title.' },
    description: optional('Extra detail.'),
    list: optional('An existing list name if one clearly fits, otherwise a new one.'),
    assignee: optional(
      'A family member name, or "group" if it is for whoever picks it up.',
    ),
    waiting_on: optional(
      'Somebody OUTSIDE the family the task depends on — a contractor, a shop, ' +
        "a doctor's office, a relative, a company. Never a family member.",
    ),
    priority: optionalEnum(['high', 'medium', 'low'], 'How urgent it genuinely is.'),
    due_date: optional('YYYY-MM-DD resolved from today.'),
  },
};

const QUERY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['scope', 'member', 'list', 'search', 'period'],
  properties: {
    scope: {
      type: 'string',
      enum: ['mine', 'member', 'list', 'unclaimed', 'next', 'all', 'waiting', 'completed'],
      description:
        '"next" for the single most pressing thing ("what\'s next", "what should I do now"); ' +
        '"mine" for the asker\'s whole list; "all" for the family\'s open tasks; ' +
        '"member" for someone else\'s; "list" for one named list; "unclaimed" for unowned work; ' +
        '"waiting" for everything the family is waiting on an outsider for; ' +
        '"completed" for work already finished ("what did we get done this month").',
    },
    member: optional('Whose tasks, for scope=member.'),
    list: optional('Which list, for scope=list.'),
    search: optional('Words to filter by.'),
    period: optionalEnum(
      ['week', 'month', 'quarter', 'year'],
      'How far back, for scope=completed. Empty means the past week.',
    ),
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
    'new_waiting_on',
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
    tasks: {
      type: 'array',
      items: TASK_SCHEMA,
      description:
        'Tasks to create. Required when intent is new_task — at least one, never ' +
        'empty. Empty array otherwise.',
    },
    target_task_hint: optional(
      'Words identifying the existing task being updated or discussed.',
    ),
    new_state: optionalEnum(
      ['todo', 'in_progress', 'blocked', 'needs_clarification', 'done', 'cancelled'],
      'The state the message moves an existing task to.',
    ),
    new_due_date: optional("YYYY-MM-DD when the message moves an existing task's deadline."),
    new_assignee: optional(
      'A family member name; "group" when it is thrown open to the family for ' +
        'whoever picks it up ("someone else grab it"); "unassigned" only when it ' +
        'should explicitly belong to nobody. Only for intent=reassignment.',
    ),
    new_waiting_on: optional(
      'The outsider an existing task now hangs on; the exact string "none" when ' +
        'they have come back and the wait is over.',
    ),
    comment: optional('Text to append to the task thread.'),
    query: {
      anyOf: [QUERY_SCHEMA, { type: 'null' }],
      description: 'Only for intent=query. Null otherwise.',
    },
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
- Every field is required. Where a field does not apply, give it the empty
  string "" rather than inventing a value — "" is how you say "not stated".
- Prefer chitchat when unsure. A missed task is recoverable; a chat log full of
  junk tasks is not. In a group chat especially, only pull out a task when
  someone is clearly asking for something to be done.
- One message can contain several new tasks. Split them.
- Only use a list name from the known lists unless the message clearly names a
  new one. Leave list empty rather than guessing.
- Only use assignee names from the known family members. Use "group" when the
  message is addressed to everyone or to no one in particular.
- Resolve relative dates ("tomorrow", "Friday") against today's date.
- Moving a deadline on an existing task is a status_update or comment with
  new_due_date set — not a new task.
- Set priority high only for genuine urgency, not politeness ("please" is not urgent).
- "What have we finished/done/completed lately" is a query with scope=completed,
  never a status_update. Pick the period from the words used: "this week" week,
  "this month" month, "this quarter" quarter, "this year" year.
- waiting_on is for people OUTSIDE the family — a plumber, the school office,
  an insurer, a relative who is not a member. A family member's name NEVER goes
  in waiting_on; that is what assignee is for. "Ask the plumber to come Thursday"
  is waiting_on "the plumber", assignee null (whoever raised it chases it).
  "Preethi is chasing the insurance company" is assignee "Preethi",
  waiting_on "the insurance company".
- When an outsider finally comes back ("the plumber called", "the school
  replied"), that is a status_update or comment with new_waiting_on set to
  "none".`;

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

  const parsed = await structuredCall<ParsedMessage>(client, {
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
  return parsed ? normalize(parsed) : null;
}

/**
 * The schema says "empty string" where the rest of the codebase says null,
 * because unions are rationed and optionality is not. Converting here keeps
 * that entirely inside the agent layer: every caller still sees nulls.
 *
 * Exported for the eval harness, which scores raw tool output.
 */
export function normalize(parsed: ParsedMessage): ParsedMessage {
  const blank = <T>(value: T): T | null =>
    typeof value === 'string' && value.trim() === '' ? null : value;

  return {
    ...parsed,
    tasks: (parsed.tasks ?? []).map((task) => ({
      ...task,
      description: blank(task.description),
      list: blank(task.list),
      assignee: blank(task.assignee),
      waiting_on: blank(task.waiting_on),
      priority: blank(task.priority),
      due_date: blank(task.due_date),
    })),
    target_task_hint: blank(parsed.target_task_hint),
    new_state: blank(parsed.new_state),
    new_due_date: blank(parsed.new_due_date),
    new_assignee: blank(parsed.new_assignee),
    new_waiting_on: blank(parsed.new_waiting_on),
    comment: blank(parsed.comment),
    query: parsed.query
      ? {
          ...parsed.query,
          member: blank(parsed.query.member),
          list: blank(parsed.query.list),
          search: blank(parsed.query.search),
          period: blank(parsed.query.period),
        }
      : null,
  };
}
