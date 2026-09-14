import type { Digest } from '../core/services/digest.ts';
import { effectivePriority, timingOf } from '../core/priority.ts';
import { stateLabel } from '../core/state-machine.ts';
import type { TaskEvent, TaskList, TaskView } from '../core/types.ts';
import type { FamilyMember } from '../core/types.ts';
import { isClosed } from '../core/state-machine.ts';
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
  /**
   * Off only under a heading that already states ownership, such as the
   * digest's "Up for grabs" tail. Never off merely because the reader could
   * work it out.
   */
  showOwner?: boolean;
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
  // Always named, even in someone's own digest. Who holds a task is the
  // question a family asks first, and a reader should never have to know a
  // rule to answer it.
  const owner = opts.showOwner === false
    ? ''
    : task.assignee_kind === 'group'
      ? ' — up for grabs'
      : task.assignee_kind === 'unassigned'
        ? ' — unassigned'
        : task.assignee_name
          ? ` — ${firstName(task.assignee_name)}`
          : ' — unassigned';
  const list = opts.showList ? ` [${task.list_name}]` : '';
  return `${n}${mark} ${pri ? `${pri} ` : ''}${task.title}${due}${list}${owner}`.trim();
}

/** A list tag on every line when there is only one list is noise, and it
 *  reads as an assignee. */
export function multipleLists(tasks: TaskView[]): boolean {
  return new Set(tasks.map((t) => t.list_name)).size > 1;
}

export interface BoardView {
  /** Everything above the task lines: greeting, agent intro, or a heading. */
  preamble: string;
  tasks: TaskView[];
  /** Nobody owns these yet; rendered under their own heading, tap to claim. */
  unclaimed: TaskView[];
  footer?: string;
}

/**
 * The one renderer behind every task listing -- digest, group board, command
 * output. Sharing it means a tap redraws any of them the same way, with the
 * same buttons, from live rows.
 */
export function renderBoard(board: BoardView, now: Date = new Date()): RenderedMessage {
  const { preamble, tasks, unclaimed, footer } = board;
  const lines: string[] = [preamble, ''];
  const showList = multipleLists([...tasks, ...unclaimed]);

  if (tasks.length === 0 && unclaimed.length === 0) {
    lines.push('Nothing here right now. 🎉');
  } else {
    tasks.forEach((t, i) => lines.push(taskLine(t, { index: i + 1, now, showList })));
  }

  if (unclaimed.length > 0) {
    if (tasks.length > 0) lines.push('', 'Up for grabs:');
    unclaimed.forEach((t) => lines.push(`• ${taskLine(t, { now, showList, showOwner: false })}`));
  }
  if (footer) lines.push('', footer);

  const buttons: Button[][] = [];
  for (const t of tasks) {
    // A closed task keeps its line -- seeing it tick over is the point --
    // but offers nothing to tap except a way back into its history.
    if (isClosed(t.state)) {
      buttons.push([{ label: `✓ ${truncate(t.title, 24)}`, action: { kind: 'task_show', taskId: t.id } }]);
      continue;
    }
    buttons.push([
      { label: `✓ ${truncate(t.title, 22)}`, action: { kind: 'task_done', taskId: t.id } },
      { label: '⋯', action: { kind: 'task_menu', taskId: t.id } },
    ]);
  }
  for (const t of unclaimed) {
    buttons.push([
      { label: `🙋 Claim: ${truncate(t.title, 20)}`, action: { kind: 'task_claim', taskId: t.id } },
      { label: '⋯', action: { kind: 'task_menu', taskId: t.id } },
    ]);
  }

  return {
    text: lines.join('\n'),
    buttons: buttons.length ? buttons : undefined,
    view: {
      k: 'board',
      preamble,
      ...(footer ? { footer } : {}),
      ids: tasks.map((t) => t.id),
      claimIds: unclaimed.map((t) => t.id),
    },
  };
}

/** The digest's fixed opening line, kept apart so a redraw can reuse it
 *  without re-running the agent that may have replaced it. */
export function digestPreamble(digest: Digest): string {
  return `Morning ${firstName(digest.member.name)} — here's your day.`;
}

export function digestFooter(digest: Digest): string {
  const lines = [`Lists: ${digest.lists.map((l) => l.name).join(', ') || 'none yet'}`];
  if (digest.needsListChoice) {
    lines.push('You have more lists than a digest holds — /digestlists to pick your 3.');
  }
  return lines.join('\n');
}

export function renderGroupBoard(tasks: TaskView[], now: Date = new Date()): RenderedMessage {
  if (tasks.length === 0) return { text: 'No unclaimed family tasks right now. ✨' };
  return renderBoard({ preamble: 'Up for grabs — tap to claim:', tasks: [], unclaimed: tasks }, now);
}

export function renderTaskList(
  title: string,
  tasks: TaskView[],
  now: Date = new Date(),
): RenderedMessage {
  if (tasks.length === 0) return { text: `${title}\n\nNothing here.` };
  // Telegram will render any number of rows, but a keyboard taller than the
  // screen buries the message it belongs to.
  return renderBoard({ preamble: title, tasks: tasks.slice(0, 8), unclaimed: [] }, now);
}

/** Everything you can do to one task, opened by the ⋯ button. Keeping the
 *  board rows to two buttons is what makes room for this. */
export function renderTaskMenu(task: TaskView, now: Date = new Date()): RenderedMessage {
  const lines = [taskLine(task, { now }), '', 'What do you want to do with it?'];
  const rows: Button[][] = [
    [
      { label: '✓ Done', action: { kind: 'task_done', taskId: task.id } },
      { label: '▶ Start', action: { kind: 'task_start', taskId: task.id } },
    ],
    [
      { label: '⛔ Blocked', action: { kind: 'task_block', taskId: task.id } },
      { label: '❓ Needs info', action: { kind: 'task_ask', taskId: task.id } },
    ],
    [
      { label: '👤 Reassign', action: { kind: 'task_reassign', taskId: task.id } },
      { label: '💬 Details', action: { kind: 'task_show', taskId: task.id } },
    ],
    [{ label: '↩ Back', action: { kind: 'view_back' } }],
  ];
  return { text: lines.join('\n'), buttons: rows, view: { k: 'menu', id: task.id } };
}

/** Finishing a task is the one tap that is awkward to undo in a group, so
 *  it asks. Every other action applies straight away. */
export function renderConfirmDone(task: TaskView, now: Date = new Date()): RenderedMessage {
  return {
    text: [`Mark this done?`, '', taskLine(task, { now })].join('\n'),
    buttons: [
      [
        { label: '✓ Yes, mark it done', action: { kind: 'task_done_confirm', taskId: task.id } },
        { label: '✗ Not yet', action: { kind: 'view_back' } },
      ],
    ],
    view: { k: 'confirm', id: task.id },
  };
}

export function renderAssignPicker(
  task: TaskView,
  members: FamilyMember[],
  now: Date = new Date(),
): RenderedMessage {
  const rows: Button[][] = members.map((m) => [
    {
      label: `${task.assigned_to === m.id ? '• ' : ''}${firstName(m.name)}`,
      action: { kind: 'task_assign' as const, taskId: task.id, to: m.id },
    },
  ]);
  rows.push([
    {
      label: `${task.assignee_kind === 'group' ? '• ' : ''}🙌 Up for grabs`,
      action: { kind: 'task_assign' as const, taskId: task.id, to: 'group' },
    },
  ]);
  rows.push([{ label: '↩ Back', action: { kind: 'view_back' } }]);
  return {
    text: [`Who should own this?`, '', taskLine(task, { now })].join('\n'),
    buttons: rows,
    view: { k: 'assign', id: task.id },
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
      [
        { label: '👤 Reassign', action: { kind: 'task_reassign', taskId: task.id } },
        { label: '↩ Back', action: { kind: 'view_back' } },
      ],
    ],
    view: { k: 'detail', id: task.id },
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
    view: { k: 'lists' },
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
