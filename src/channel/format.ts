import type { Digest } from '../core/services/digest.ts';
import { dayDiff, effectivePriority, timingOf } from '../core/priority.ts';
import { stateLabel } from '../core/state-machine.ts';
import type { TaskEvent, TaskList, TaskView } from '../core/types.ts';
import type { FamilyMember } from '../core/types.ts';
import { isClosed } from '../core/state-machine.ts';
import type { PickMode } from '../core/services/views.ts';
import type { Button, RenderedMessage } from './types.ts';

const PRIORITY_MARK: Record<string, string> = { high: '!!', medium: '', low: '·' };
const STATE_MARK: Record<string, string> = {
  todo: '○',
  in_progress: '▶',
  blocked: '⊘',
  needs_clarification: '?',
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
  // Spelled out rather than marked with a glyph: who holds a task has been
  // misread here before, and "waiting on the plumber" is a second holder.
  const waiting = task.waiting_on && !isClosed(task.state) ? ` · waiting on ${task.waiting_on}` : '';
  return `${n}${mark} ${pri ? `${pri} ` : ''}${task.title}${due}${list}${owner}${waiting}`.trim();
}

/**
 * How many tasks a board shows, and the picker therefore has to offer.
 *
 * WhatsApp allows ten rows in a list message and the picker needs one of
 * them for Back, which leaves nine. The board honours the same nine so that
 * everything on screen is reachable -- a board that listed more than its
 * own picker could offer would show tasks nothing could act on.
 */
const MAX_ROWS = 9;

/** A list tag on every line when there is only one list is noise, and it
 *  reads as an assignee. */
export function multipleLists(tasks: TaskView[]): boolean {
  return new Set(tasks.map((t) => t.list_name)).size > 1;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A due date as someone would say it out loud. "2026-09-23" makes a reader
 * do arithmetic before they know whether it matters; "tomorrow" does not.
 */
export function relativeDate(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const days = dayDiff(now, d);
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  // Inside the coming week a weekday name is both shorter and unambiguous.
  // Past that it stops being unambiguous, so fall back to the date.
  if (days > 1 && days < 7) return WEEKDAYS[d.getUTCDay()] ?? shortDate(iso);
  if (days < -1 && days > -7) return `last ${WEEKDAYS[d.getUTCDay()] ?? ''}`.trim();
  return `${MONTHS[d.getUTCMonth()] ?? ''} ${d.getUTCDate()}`.trim();
}

/** Overdue outranks the state glyph: a late task is the one thing a reader
 *  should find without reading. */
function boardMark(task: TaskView, now: Date): string {
  if (!isClosed(task.state) && timingOf(task, now) === 'overdue') return '!';
  return STATE_MARK[task.state] ?? '\u25cb';
}

function ownerWord(task: TaskView, viewer?: string): string {
  if (task.assignee_kind === 'group') return 'up for grabs';
  if (task.assignee_kind === 'unassigned' || !task.assignee_name) return 'unassigned';
  // Your own name repeated down the margin of your own digest is noise;
  // everyone else's name is the first thing a family looks for.
  if (viewer && task.assigned_to === viewer) return 'you';
  return firstName(task.assignee_name);
}

interface EntryOptions {
  showList?: boolean;
  showOwner?: boolean;
  viewer?: string;
}

/**
 * The second line of a board entry: everything about a task that is not its
 * title, in the order a reader wants it -- when, who, what is holding it
 * up. One line only; the rest is what the detail view is for.
 */
function boardMeta(task: TaskView, now: Date, opts: EntryOptions): string {
  const open = !isClosed(task.state);
  const bits: string[] = [];
  if (task.due_at && open) {
    const when = relativeDate(task.due_at, now);
    bits.push(timingOf(task, now) === 'overdue' ? `was due ${when}` : when);
  }
  if (opts.showOwner !== false) bits.push(ownerWord(task, opts.viewer));
  // Spelled out rather than marked with a glyph: who holds a task has been
  // misread here before, and "waiting on the plumber" is a second holder.
  if (task.waiting_on && open) bits.push(`waiting on ${task.waiting_on}`);
  if (opts.showList) bits.push(task.list_name);
  // Redundant next to "was due Monday", which already says it is urgent.
  if (open && task.priority === 'high' && timingOf(task, now) !== 'overdue') bits.push('high');
  return bits.join(' \u00b7 ');
}

/** One task, two lines: the glyph and title a reader scans down, then
 *  everything else indented underneath. */
function entry(task: TaskView, now: Date, opts: EntryOptions): string {
  const head = `${boardMark(task, now)}  ${task.title}`;
  const meta = boardMeta(task, now, opts);
  return meta ? `${head}\n    ${meta}` : head;
}

/** "5 open · 1 overdue" -- the line that says whether to keep reading. */
function summarise(tasks: TaskView[], now: Date): string {
  const open = tasks.filter((t) => !isClosed(t.state));
  const overdue = open.filter((t) => timingOf(t, now) === 'overdue');
  const closed = tasks.length - open.length;
  const bits: string[] = [];
  if (open.length > 0) bits.push(`${open.length} open`);
  if (overdue.length > 0) bits.push(`${overdue.length} overdue`);
  if (closed > 0) bits.push(`${closed} done`);
  return bits.join(' \u00b7 ');
}

export interface BoardView {
  /** Everything above the task lines: greeting, agent intro, or a heading. */
  preamble: string;
  tasks: TaskView[];
  /** Nobody owns these yet; rendered under their own heading, tap to claim. */
  unclaimed: TaskView[];
  footer?: string;
  /** Whose screen this is. Only used to say "you" instead of their name. */
  viewer?: string;
}

/**
 * The one renderer behind every task listing -- digest, group board, command
 * output. Sharing it means a tap redraws any of them the same way, with the
 * same buttons, from live rows.
 *
 * Two lines per task, and three buttons however long the list is. The
 * version before this one put a button on screen per task and labelled it
 * with the line number: it doubled the height of every message, and it made
 * the reader match "3" against a line before every single tap. Choosing the
 * task is now a step of its own (renderPicker) -- one more tap, in exchange
 * for a board that reads like something a person wrote down.
 */
export function renderBoard(board: BoardView, now: Date = new Date()): RenderedMessage {
  const { preamble, footer, viewer } = board;
  // Truncated here rather than by each caller, so the ids recorded in the
  // view are exactly the ones on screen and the picker can never offer a
  // row the reader cannot see.
  const tasks = board.tasks.slice(0, MAX_ROWS);
  const unclaimed = board.unclaimed.slice(0, Math.max(0, MAX_ROWS - tasks.length));
  const hidden = board.tasks.length + board.unclaimed.length - tasks.length - unclaimed.length;
  const all = [...tasks, ...unclaimed];
  const opts: EntryOptions = {
    showList: multipleLists(all),
    ...(viewer ? { viewer } : {}),
  };

  const lines: string[] = [preamble];
  const counts = summarise(all, now);
  if (counts) lines.push(counts);
  if (all.length === 0) lines.push('', 'Nothing here right now. \u{1F389}');

  for (const t of tasks) lines.push('', entry(t, now, opts));
  if (unclaimed.length > 0) {
    // Only worth a heading when there is something above it to divide from.
    if (tasks.length > 0) lines.push('', 'UP FOR GRABS');
    for (const t of unclaimed) lines.push('', entry(t, now, { ...opts, showOwner: false }));
  }
  if (hidden > 0) lines.push('', `…and ${hidden} more. Narrow it down and I'll show those.`);
  if (footer) lines.push('', footer);

  const row: Button[] = [];
  if (tasks.some((t) => !isClosed(t.state))) {
    row.push({ label: '\u2713 Complete', action: { kind: 'board_pick', mode: 'done' }, primary: true });
  }
  if (unclaimed.length > 0) {
    row.push({ label: '+ Claim', action: { kind: 'board_pick', mode: 'claim' }, primary: true });
  }
  if (all.length > 0) {
    row.push({ label: '\u22ef Manage', action: { kind: 'board_pick', mode: 'manage' } });
  }

  return {
    text: lines.join('\n'),
    ...(row.length > 0 ? { buttons: [row] } : {}),
    view: {
      k: 'board',
      preamble,
      ...(footer ? { footer } : {}),
      ids: tasks.map((t) => t.id),
      claimIds: unclaimed.map((t) => t.id),
    },
  };
}

/**
 * Which task? Drawn over the board in the same message by one of its three
 * buttons, and closed by acting or by Back.
 *
 * Every row carries a title in words, which is the confirmation a numbered
 * button could never give: you tap the name of the thing you mean. That is
 * why finishing from here applies straight away rather than asking again --
 * and why a finished task keeps a Reopen in its menu.
 */
export function renderPicker(
  mode: PickMode,
  tasks: TaskView[],
  now: Date = new Date(),
): RenderedMessage {
  const [heading, sub] = {
    done: ['Which one is done?', "Tap it and I'll close it out."],
    claim: ['Which one will you take?', 'It becomes yours, and the family sees that.'],
    manage: ['Which one?', 'Opens everything you can do to it.'],
  }[mode];
  const rows: Button[][] = tasks.slice(0, MAX_ROWS).map((t) => [
    {
      label: `${boardMark(t, now)} ${truncate(t.title, 26)}`,
      action:
        mode === 'done'
          ? ({ kind: 'task_done_confirm', taskId: t.id } as const)
          : mode === 'claim'
            ? ({ kind: 'task_claim', taskId: t.id } as const)
            : ({ kind: 'task_menu', taskId: t.id } as const),
      primary: true,
    },
  ]);
  const text =
    rows.length === 0
      ? ['Nothing left to pick.', '', 'The list moved on while this was open.'].join('\n')
      : [heading ?? '', '', sub ?? ''].join('\n');
  rows.push([{ label: '\u21a9 Back', action: { kind: 'view_back' } }]);
  return { text, buttons: rows, view: { k: 'pick', mode } };
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
  return renderBoard({ preamble: title, tasks, unclaimed: [] }, now);
}

/** Everything you can do to one task, opened by the ⋯ button. Keeping the
 *  board rows to two buttons is what makes room for this. */
export function renderTaskMenu(task: TaskView, now: Date = new Date()): RenderedMessage {
  const lines = [taskLine(task, { now }), '', 'What do you want to do with it?'];
  // Reopen is the whole safety net under finishing a task from the picker
  // without a confirmation step, so a closed task leads with it.
  const rows: Button[][] = isClosed(task.state)
    ? [
        [
          { label: '↺ Reopen', action: { kind: 'task_reopen', taskId: task.id }, primary: true },
          { label: '≡ Details', action: { kind: 'task_show', taskId: task.id } },
        ],
      ]
    : [
        [
          { label: '✓ Done', action: { kind: 'task_done', taskId: task.id }, primary: true },
          { label: '▶ Start', action: { kind: 'task_start', taskId: task.id } },
        ],
        [
          { label: '⊘ Blocked', action: { kind: 'task_block', taskId: task.id } },
          { label: '? Needs info', action: { kind: 'task_ask', taskId: task.id } },
        ],
        [
          { label: '→ Reassign', action: { kind: 'task_reassign', taskId: task.id } },
          { label: '≡ Details', action: { kind: 'task_show', taskId: task.id } },
        ],
      ];
  if (task.waiting_on) {
    rows.push([
      {
        label: `✓ ${truncate(task.waiting_on, 18)} came back`,
        action: { kind: 'task_waiting_clear', taskId: task.id },
      },
    ]);
  }
  rows.push([{ label: '↩ Back', action: { kind: 'view_back' } }]);
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
      label: `${task.assignee_kind === 'group' ? '• ' : ''}+ Up for grabs`,
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
  if (task.waiting_on) {
    lines.push(
      `Waiting on ${task.waiting_on} — outside the family, so ${
        task.assignee_name ? firstName(task.assignee_name) : 'whoever owns this'
      } chases it`,
    );
  }
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
        { label: '⊘ Block', action: { kind: 'task_block', taskId: task.id } },
      ],
      [
        { label: '→ Reassign', action: { kind: 'task_reassign', taskId: task.id } },
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
