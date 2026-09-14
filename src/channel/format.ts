import type { Digest } from '../core/services/digest.ts';
import { effectivePriority, timingOf } from '../core/priority.ts';
import { stateLabel } from '../core/state-machine.ts';
import type { TaskEvent, TaskList, TaskView } from '../core/types.ts';
import type { Button, RenderedMessage } from './types.ts';

const PRIORITY_MARK: Record<string, string> = { high: '!!', medium: '', low: '·' };
const STATE_MARK: Record<string, string> = {
  todo: '○',
  in_progress: '▶',
  blocked: '⛔',
  needs_clarification: '❓',
  done: '✓',
  cancelled: '✕',
};

export interface LineOptions {
  index?: number;
  now?: Date;
  /** Only worth printing when more than one list is on screen. */
  showList?: boolean;
  /** Only worth printing where the tasks are not all the reader's own. */
  showAssignee?: boolean;
}

export function taskLine(task: TaskView, opts: LineOptions = {}): string {
  const now = opts.now ?? new Date();
  const n = opts.index === undefined ? '' : `${opts.index}. `;
  const mark = STATE_MARK[task.state] ?? '○';
  // Escalated by the deadline, not by whatever was set when it was written.
  const pri = PRIORITY_MARK[effectivePriority(task, now)] ?? '';
  const timing = timingOf(task, now);
  const due = task.due_at
    ? timing === 'overdue'
      ? ` (OVERDUE — was due ${shortDate(task.due_at)})`
      : ` (due ${shortDate(task.due_at)})`
    : '';
  const owner =
    task.assignee_kind === 'group'
      ? ' — up for grabs'
      : task.assignee_kind === 'unassigned'
        ? ' — unassigned'
        : opts.showAssignee && task.assignee_name
          ? ` — ${firstName(task.assignee_name)}`
          : '';
  const list = opts.showList ? ` [${task.list_name}]` : '';
  return `${n}${mark} ${pri ? `${pri} ` : ''}${task.title}${due}${list}${owner}`.trim();
}

/** A list tag on every line when there is only one list is noise, and it
 *  reads as an assignee. */
export function multipleLists(tasks: TaskView[]): boolean {
  return new Set(tasks.map((t) => t.list_name)).size > 1;
}

export function renderDigest(digest: Digest): RenderedMessage {
  const { member, items, unclaimed, lists, needsListChoice } = digest;
  const lines: string[] = [`Morning ${firstName(member.name)} — here's your day.`, ''];

  if (items.length === 0) {
    lines.push('Nothing assigned to you right now. 🎉');
  } else {
    const showList = multipleLists([...items, ...unclaimed]);
    items.forEach((t, i) => lines.push(taskLine(t, { index: i + 1, showList })));
  }

  if (unclaimed.length > 0) {
    lines.push('', 'Up for grabs:');
    unclaimed.forEach((t) => lines.push(`• ${t.title} [${t.list_name}]`));
  }

  lines.push('', `Lists: ${lists.map((l) => l.name).join(', ') || 'none yet'}`);
  if (needsListChoice) {
    lines.push('You have more lists than a digest holds — /digestlists to pick your 3.');
  }

  const buttons: Button[][] = [];
  for (const t of items) {
    buttons.push([
      { label: `✓ ${truncate(t.title, 22)}`, action: { kind: 'task_done', taskId: t.id } },
      { label: '▶', action: { kind: 'task_start', taskId: t.id } },
      { label: '💬', action: { kind: 'task_show', taskId: t.id } },
    ]);
  }
  for (const t of unclaimed) {
    buttons.push([
      { label: `🙋 Claim: ${truncate(t.title, 22)}`, action: { kind: 'task_claim', taskId: t.id } },
    ]);
  }

  return { text: lines.join('\n'), buttons: buttons.length ? buttons : undefined };
}

export function renderGroupBoard(tasks: TaskView[]): RenderedMessage {
  if (tasks.length === 0) {
    return { text: 'No unclaimed family tasks right now. ✨' };
  }
  const lines = ['Up for grabs — tap to claim:', ''];
  const showList = multipleLists(tasks);
  tasks.forEach((t, i) => lines.push(taskLine(t, { index: i + 1, showList })));
  return {
    text: lines.join('\n'),
    buttons: tasks.map((t) => [
      { label: `🙋 ${truncate(t.title, 28)}`, action: { kind: 'task_claim' as const, taskId: t.id } },
    ]),
  };
}

export function renderTaskList(
  title: string,
  tasks: TaskView[],
  opts: { showAssignee?: boolean } = {},
): RenderedMessage {
  if (tasks.length === 0) return { text: `${title}\n\nNothing here.` };
  const lines = [title, ''];
  const showList = multipleLists(tasks);
  tasks.forEach((t, i) =>
    lines.push(taskLine(t, { index: i + 1, showList, showAssignee: opts.showAssignee })),
  );
  return {
    text: lines.join('\n'),
    buttons: tasks
      .slice(0, 8)
      .map((t) => [
        { label: `✓ ${truncate(t.title, 24)}`, action: { kind: 'task_done' as const, taskId: t.id } },
      ]),
  };
}

export function renderTaskDetail(
  task: TaskView,
  thread: TaskEvent[],
  memberNames: Map<string, string>,
  now: Date = new Date(),
): RenderedMessage {
  const priority = effectivePriority(task, now);
  const escalated = priority !== task.priority ? ` (raised from ${task.priority})` : '';
  const lines = [
    task.title,
    `${stateLabel(task.state)} · ${priority}${escalated} · [${task.list_name}]`,
  ];
  if (task.assignee_name) lines.push(`Assigned to ${task.assignee_name}`);
  else lines.push(task.assignee_kind === 'group' ? 'Open to the family' : 'Unassigned');
  if (task.due_at) {
    const timing = timingOf(task, now);
    lines.push(
      timing === 'overdue'
        ? `Due ${shortDate(task.due_at)} — OVERDUE`
        : `Due ${shortDate(task.due_at)}`,
    );
  }
  // Who asked for this and when. Both have always been stored; nothing
  // showed them, so a task read as though it came from nowhere.
  const reporter = task.created_by ? memberNames.get(task.created_by) : null;
  lines.push(`Added by ${reporter ?? 'someone'} on ${shortDate(task.created_at)}`);
  if (task.description) lines.push('', task.description);

  const comments = thread.filter((e) => e.kind === 'comment' && e.body);
  if (comments.length > 0) {
    lines.push('', 'Thread:');
    for (const c of comments.slice(-5)) {
      const who = c.actor_member_id ? memberNames.get(c.actor_member_id) ?? 'someone' : 'someone';
      lines.push(`— ${who}: ${c.body}`);
    }
  }

  return {
    text: lines.join('\n'),
    buttons: [
      [
        { label: '✓ Done', action: { kind: 'task_done', taskId: task.id } },
        { label: '▶ Start', action: { kind: 'task_start', taskId: task.id } },
        { label: '⛔ Block', action: { kind: 'task_block', taskId: task.id } },
      ],
    ],
  };
}

export function renderDigestListPicker(
  all: TaskList[],
  selected: Set<string>,
  max: number,
): RenderedMessage {
  return {
    text: `Pick up to ${max} lists for your daily digest. Everything else stays available on demand.`,
    buttons: all.map((l) => [
      {
        label: `${selected.has(l.id) ? '☑' : '☐'} ${truncate(l.name, 28)}`,
        action: { kind: 'digest_list_toggle' as const, listId: l.id },
      },
    ]),
  };
}

export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(0, 10);
}
