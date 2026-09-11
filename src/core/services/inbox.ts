/**
 * Applies a parsed message to the database. This is where the agent's
 * classification becomes real state.
 *
 * It imports the parser's result *type* only -- no runtime dependency on the
 * agent layer -- so the whole path is testable with hand-written fixtures.
 */
import type { ParsedMessage, ParsedTask } from '../../agents/parser.ts';
import { renderTaskList, taskLine } from '../../channel/format.ts';
import type { RenderedMessage } from '../../channel/types.ts';
import type { Db } from '../db/adapter.ts';
import { UserError } from '../errors.ts';
import { inferPriorityFromText } from '../priority.ts';
import { OPEN_STATES, stateLabel } from '../state-machine.ts';
import type { AssigneeKind, FamilyMember, Priority, TaskView } from '../types.ts';
import { isPriority } from '../types.ts';
import { allLists, resolveList } from './lists.ts';
import { answerQuery } from './queries.ts';
import { listMembers, matchMemberByName } from './registry.ts';
import { addComment, assign, createTask, getTaskView, queryTasks, setState } from './tasks.ts';

/** Below this the message is treated as chit-chat. Group chat is noisier, so
 *  it needs a clearer signal before anything is written. */
export const CONFIDENCE_FLOOR = { dm: 0.5, group: 0.65 } as const;

export interface Notification {
  memberId: string;
  message: RenderedMessage;
}

export interface InboxResult {
  /** Sent back into the chat the message came from. */
  reply: RenderedMessage | null;
  /** DMs to people who are not in that chat but need to know. */
  notify: Notification[];
}

export interface InboxContext {
  familyId: string;
  speaker: FamilyMember;
  chatType: 'dm' | 'group';
  chatId: string;
  messageId: string;
  rawText: string;
}

const NOTHING: InboxResult = { reply: null, notify: [] };

export async function applyParsed(
  db: Db,
  ctx: InboxContext,
  parsed: ParsedMessage,
): Promise<InboxResult> {
  if (parsed.intent === 'chitchat') return NOTHING;
  if ((parsed.confidence ?? 0) < CONFIDENCE_FLOOR[ctx.chatType]) return NOTHING;

  switch (parsed.intent) {
    case 'new_task':
      return createFromParsed(db, ctx, parsed.tasks ?? []);
    case 'status_update':
      return applyStatusUpdate(db, ctx, parsed);
    case 'reassignment':
      return applyReassignment(db, ctx, parsed);
    case 'clarification':
    case 'comment':
      return applyComment(db, ctx, parsed);
    case 'query':
      return {
        reply: await answerQuery(db, ctx.speaker, {
          scope: parsed.query?.scope ?? 'mine',
          member: parsed.query?.member,
          list: parsed.query?.list,
          search: parsed.query?.search,
        }),
        notify: [],
      };
    default:
      return NOTHING;
  }
}

/**
 * Who needs a DM about this task, other than whoever is already reading the
 * reply. Without this an assignee learns about their own task at 9am
 * tomorrow, which is too late to be useful.
 */
function audienceFor(task: TaskView, speakerId: string): string[] {
  const people = new Set<string>();
  if (task.assigned_to && task.assigned_to !== speakerId) people.add(task.assigned_to);
  if (task.created_by && task.created_by !== speakerId) people.add(task.created_by);
  return [...people];
}

async function createFromParsed(
  db: Db,
  ctx: InboxContext,
  specs: ParsedTask[],
): Promise<InboxResult> {
  // The agent said "this is a task" and then extracted none. Dropping the
  // message would lose work the person clearly asked for, so fall back to
  // their own words as the title.
  const effective =
    specs.length > 0 ? specs : [{ title: ctx.rawText.trim().slice(0, 200) } satisfies ParsedTask];
  if (!effective[0]?.title) return NOTHING;
  specs = effective;
  const members = await listMembers(db, ctx.familyId);
  const created: TaskView[] = [];

  for (const spec of specs) {
    if (!spec.title?.trim()) continue;
    const list = await resolveList(db, ctx.familyId, spec.list);
    const { kind, memberId } = resolveAssignee(members, spec.assignee, ctx);
    const priority: Priority = isPriority(spec.priority)
      ? spec.priority
      : inferPriorityFromText(ctx.rawText) ?? 'medium';

    const task = await createTask(db, {
      familyId: ctx.familyId,
      listId: list.id,
      title: spec.title,
      description: spec.description ?? null,
      createdBy: ctx.speaker.id,
      assigneeKind: kind,
      assignedTo: memberId,
      priority,
      dueAt: normalizeDueDate(spec.due_date),
      sourceChatId: ctx.chatId,
      sourceMessageId: ctx.messageId,
    });
    created.push(await getTaskView(db, task.id));
  }

  if (created.length === 0) return NOTHING;

  const notify: Notification[] = [];
  for (const task of created) {
    if (task.assigned_to && task.assigned_to !== ctx.speaker.id) {
      notify.push({
        memberId: task.assigned_to,
        message: renderTaskList(`${ctx.speaker.name} added this for you:`, [task]),
      });
    }
  }

  return {
    reply: renderTaskList(
      created.length === 1 ? 'Added:' : `Added ${created.length} tasks:`,
      created,
    ),
    notify,
  };
}

async function applyStatusUpdate(
  db: Db,
  ctx: InboxContext,
  parsed: ParsedMessage,
): Promise<InboxResult> {
  const task = await findTarget(db, ctx, parsed);
  if (!task) return { reply: await notFound(db, ctx, parsed), notify: [] };
  const to = parsed.new_state ?? 'in_progress';
  try {
    await setState(db, task.id, to, ctx.speaker.id, parsed.comment ?? null);
  } catch (err) {
    if (err instanceof UserError) return { reply: { text: err.message }, notify: [] };
    throw err;
  }
  const fresh = await getTaskView(db, task.id);
  const line = `${stateLabel(to)}: ${fresh.title} [${fresh.list_name}]`;
  const note = parsed.comment ? `\n${parsed.comment}` : '';
  return {
    reply: { text: line },
    notify: audienceFor(fresh, ctx.speaker.id).map((memberId) => ({
      memberId,
      message: { text: `${ctx.speaker.name} — ${line}${note}` },
    })),
  };
}

async function applyReassignment(
  db: Db,
  ctx: InboxContext,
  parsed: ParsedMessage,
): Promise<InboxResult> {
  const task = await findTarget(db, ctx, parsed);
  if (!task) return { reply: await notFound(db, ctx, parsed), notify: [] };
  const members = await listMembers(db, ctx.familyId);
  const { kind, memberId } = resolveAssignee(members, parsed.new_assignee, ctx, 'unassigned');
  await assign(db, task.id, { kind, memberId }, ctx.speaker.id, parsed.comment ?? null);
  const who =
    kind === 'member' ? members.find((m) => m.id === memberId)?.name ?? 'someone' : 'the family';
  const fresh = await getTaskView(db, task.id);
  return {
    reply: { text: `Reassigned to ${who}: ${task.title} [${task.list_name}]` },
    notify: audienceFor(fresh, ctx.speaker.id).map((id) => ({
      memberId: id,
      message: renderTaskList(`${ctx.speaker.name} passed this to you:`, [fresh]),
    })),
  };
}

async function applyComment(
  db: Db,
  ctx: InboxContext,
  parsed: ParsedMessage,
): Promise<InboxResult> {
  const task = await findTarget(db, ctx, parsed);
  if (!task) return { reply: await notFound(db, ctx, parsed), notify: [] };
  const body = parsed.comment?.trim() || ctx.rawText;
  await addComment(db, task.id, ctx.speaker.id, body);
  if (parsed.new_state && parsed.new_state !== task.state) {
    await setState(db, task.id, parsed.new_state, ctx.speaker.id);
  }
  const fresh = await getTaskView(db, task.id);
  return {
    reply: { text: `Noted on "${task.title}".` },
    notify: audienceFor(fresh, ctx.speaker.id).map((memberId) => ({
      memberId,
      message: { text: `${ctx.speaker.name} on "${fresh.title}":\n${body}` },
    })),
  };
}

async function findTarget(
  db: Db,
  ctx: InboxContext,
  parsed: ParsedMessage,
): Promise<TaskView | null> {
  const open = await queryTasks(db, { familyId: ctx.familyId, states: OPEN_STATES, limit: 200 });
  return matchTask(open, parsed.target_task_hint ?? ctx.rawText, ctx.speaker.id);
}

async function notFound(
  db: Db,
  ctx: InboxContext,
  parsed: ParsedMessage,
): Promise<RenderedMessage> {
  const hint = parsed.target_task_hint?.trim();
  const open = await queryTasks(db, {
    familyId: ctx.familyId,
    assignedTo: ctx.speaker.id,
    includeUnclaimed: true,
    limit: 5,
  });
  const lines = [hint ? `I can't find a task matching "${hint}".` : "I'm not sure which task you mean."];
  if (open.length > 0) {
    lines.push('', 'Open right now:');
    open.forEach((t) => lines.push(taskLine(t)));
  }
  return { text: lines.join('\n') };
}

/**
 * Match an update to an existing task by word overlap. Deliberately dumb and
 * deterministic: the agent already told us what it thinks the target is, and
 * a second model call here would be slower and no more reliable on
 * three-word titles.
 */
export function matchTask(
  tasks: TaskView[],
  hint: string,
  preferAssignee?: string,
): TaskView | null {
  const needles = tokenize(hint);
  if (needles.size === 0) return null;

  let best: TaskView | null = null;
  let bestScore = 0;
  for (const task of tasks) {
    const hay = tokenize(`${task.title} ${task.description ?? ''} ${task.list_name}`);
    let overlap = 0;
    for (const word of needles) if (hay.has(word)) overlap += 1;
    if (overlap === 0) continue;
    let score = overlap / Math.max(1, Math.min(needles.size, hay.size));
    if (preferAssignee && task.assigned_to === preferAssignee) score += 0.15;
    if (score > bestScore) {
      bestScore = score;
      best = task;
    }
  }
  return bestScore >= 0.34 ? best : null;
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'to', 'i', 'it', 'that', 'this', 'on', 'for', 'of', 'and', 'my', 'me',
  'we', 'you', 'have', 'has', 'did', 'do', 'done', 'am', 'was', 'been', 'get', 'got', 'with',
  'about', 'from', 'now', 'just', 'can', 'will', 'be', 'in', 'at', 'up', 'out',
]);

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  );
}

function resolveAssignee(
  members: FamilyMember[],
  raw: string | null | undefined,
  ctx: InboxContext,
  fallback: AssigneeKind = 'unassigned',
): { kind: AssigneeKind; memberId: string | null } {
  const name = raw?.trim().toLowerCase();
  if (!name) {
    // A task raised in a DM with nobody named is the speaker's own.
    return ctx.chatType === 'dm' && fallback === 'unassigned'
      ? { kind: 'member', memberId: ctx.speaker.id }
      : { kind: fallback, memberId: null };
  }
  if (name === 'group' || name === 'family' || name === 'everyone' || name === 'anyone') {
    return { kind: 'group', memberId: null };
  }
  if (name === 'unassigned' || name === 'nobody' || name === 'none') {
    return { kind: 'unassigned', memberId: null };
  }
  if (name === 'me' || name === 'myself') return { kind: 'member', memberId: ctx.speaker.id };
  const match = matchMemberByName(members, name);
  return match ? { kind: 'member', memberId: match.id } : { kind: 'group', memberId: null };
}

/** Accept YYYY-MM-DD from the agent; store as an ISO timestamp. */
function normalizeDueDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00Z`) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export async function listNamesFor(db: Db, familyId: string): Promise<string[]> {
  return (await allLists(db, familyId)).map((l) => l.name);
}
