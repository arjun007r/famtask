import type { Db, SqlParam } from '../db/adapter.ts';
import { newId, nowIso } from '../ids.ts';
import { UserError } from '../errors.ts';
import { assertTransition, CLOSED_STATES, isClosed, OPEN_STATES } from '../state-machine.ts';
import { rankScore } from '../priority.ts';
import type { AssigneeKind, Priority, Task, TaskEvent, TaskState, TaskView } from '../types.ts';

const VIEW_SELECT = `
  SELECT t.*, l.name AS list_name, m.name AS assignee_name
    FROM tasks t
    JOIN lists l ON l.id = t.list_id
    LEFT JOIN family_members m ON m.id = t.assigned_to`;

export interface CreateTaskInput {
  familyId: string;
  listId: string;
  title: string;
  description?: string | null;
  createdBy?: string | null;
  assigneeKind?: AssigneeKind;
  assignedTo?: string | null;
  waitingOn?: string | null;
  priority?: Priority;
  dueAt?: string | null;
  sourceChatId?: string | null;
  sourceMessageId?: string | null;
}

export async function createTask(db: Db, input: CreateTaskInput): Promise<Task> {
  const title = input.title.trim();
  if (!title) throw new UserError('A task needs a title.');

  const assignedTo = input.assignedTo ?? null;
  const assigneeKind: AssigneeKind = assignedTo
    ? 'member'
    : (input.assigneeKind === 'member' ? 'unassigned' : input.assigneeKind) ?? 'unassigned';

  const ts = nowIso();
  const task: Task = {
    id: newId('tsk'),
    family_id: input.familyId,
    list_id: input.listId,
    title,
    description: input.description?.trim() || null,
    created_by: input.createdBy ?? null,
    assignee_kind: assigneeKind,
    assigned_to: assignedTo,
    waiting_on: normalizeWaitingOn(input.waitingOn),
    state: 'todo',
    priority: input.priority ?? 'medium',
    due_at: input.dueAt ?? null,
    created_at: ts,
    updated_at: ts,
    closed_at: null,
    source_chat_id: input.sourceChatId ?? null,
    source_message_id: input.sourceMessageId ?? null,
  };

  await db.batch([
    {
      sql: `INSERT INTO tasks
              (id, family_id, list_id, title, description, created_by, assignee_kind, assigned_to,
               waiting_on, state, priority, due_at, created_at, updated_at, closed_at,
               source_chat_id, source_message_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'todo', ?, ?, ?, ?, NULL, ?, ?)`,
      params: [
        task.id,
        task.family_id,
        task.list_id,
        task.title,
        task.description,
        task.created_by,
        task.assignee_kind,
        task.assigned_to,
        task.waiting_on,
        task.priority,
        task.due_at,
        task.created_at,
        task.updated_at,
        task.source_chat_id,
        task.source_message_id,
      ],
    },
    eventStatement({
      taskId: task.id,
      actorMemberId: task.created_by,
      kind: 'created',
      toState: 'todo',
      body: null,
      createdAt: ts,
    }),
  ]);
  return task;
}

export async function getTask(db: Db, id: string): Promise<Task> {
  const row = await db.first<Task>('SELECT * FROM tasks WHERE id = ?', [id]);
  if (!row) throw new UserError('That task no longer exists.');
  return row;
}

export async function getTaskView(db: Db, id: string): Promise<TaskView> {
  const row = await db.first<TaskView>(`${VIEW_SELECT} WHERE t.id = ?`, [id]);
  if (!row) throw new UserError('That task no longer exists.');
  return row;
}

export async function getThread(db: Db, taskId: string, limit = 50): Promise<TaskEvent[]> {
  return db.all<TaskEvent>(
    'SELECT * FROM task_events WHERE task_id = ? ORDER BY created_at, id LIMIT ?',
    [taskId, limit],
  );
}

export async function setState(
  db: Db,
  taskId: string,
  to: TaskState,
  actorMemberId: string | null,
  note?: string | null,
): Promise<Task> {
  const task = await getTask(db, taskId);
  if (task.state === to && !note) return task;
  assertTransition(task.state, to);
  const ts = nowIso();
  const closedAt = isClosed(to) ? ts : null;
  await db.batch([
    {
      sql: 'UPDATE tasks SET state = ?, updated_at = ?, closed_at = ? WHERE id = ?',
      params: [to, ts, closedAt, taskId],
    },
    eventStatement({
      taskId,
      actorMemberId,
      kind: 'state_change',
      fromState: task.state,
      toState: to,
      body: note ?? null,
      createdAt: ts,
    }),
  ]);
  return { ...task, state: to, updated_at: ts, closed_at: closedAt };
}

export async function assign(
  db: Db,
  taskId: string,
  target: { kind: AssigneeKind; memberId?: string | null },
  actorMemberId: string | null,
  note?: string | null,
): Promise<Task> {
  const task = await getTask(db, taskId);
  const memberId = target.kind === 'member' ? target.memberId ?? null : null;
  if (target.kind === 'member' && !memberId) {
    throw new UserError('I could not tell who to assign that to.');
  }
  const ts = nowIso();
  await db.batch([
    {
      sql: 'UPDATE tasks SET assignee_kind = ?, assigned_to = ?, updated_at = ? WHERE id = ?',
      params: [target.kind, memberId, ts, taskId],
    },
    eventStatement({
      taskId,
      actorMemberId,
      kind: 'reassigned',
      body: note ?? null,
      createdAt: ts,
    }),
  ]);
  return { ...task, assignee_kind: target.kind, assigned_to: memberId, updated_at: ts };
}

/**
 * Record (or clear) the outside party a task hangs on. Kept separate from
 * assignment on purpose: a family member still owns the chasing, and a task
 * with nobody chasing it never reaches a digest.
 */
export async function setWaitingOn(
  db: Db,
  taskId: string,
  waitingOn: string | null,
  actorMemberId: string | null,
): Promise<Task> {
  const task = await getTask(db, taskId);
  const next = normalizeWaitingOn(waitingOn);
  const ts = nowIso();
  await db.batch([
    {
      sql: 'UPDATE tasks SET waiting_on = ?, updated_at = ? WHERE id = ?',
      params: [next, ts, taskId],
    },
    eventStatement({
      taskId,
      actorMemberId,
      // task_events.kind is CHECK-constrained; 'edited' is what it is for.
      kind: 'edited',
      body: next ? `Waiting on ${next}` : `No longer waiting on ${task.waiting_on ?? 'anyone'}`,
      createdAt: ts,
    }),
  ]);
  return { ...task, waiting_on: next, updated_at: ts };
}

/** Trimmed, length-capped, and empty-means-null. Free text from a chat
 *  message goes straight in here. */
export function normalizeWaitingOn(value: string | null | undefined): string | null {
  const trimmed = value?.trim().replace(/\s+/g, ' ') ?? '';
  return trimmed ? trimmed.slice(0, 80) : null;
}

/** Claim an unassigned/group task. Fails loudly if someone got there first,
 *  so two people tapping Claim do not silently overwrite each other. */
export async function claim(db: Db, taskId: string, memberId: string): Promise<Task> {
  const task = await getTask(db, taskId);
  if (task.assignee_kind === 'member' && task.assigned_to !== memberId) {
    throw new UserError('Someone else already claimed that one.');
  }
  return assign(db, taskId, { kind: 'member', memberId }, memberId);
}

export async function setPriority(
  db: Db,
  taskId: string,
  priority: Priority,
  actorMemberId: string | null,
): Promise<Task> {
  const task = await getTask(db, taskId);
  if (task.priority === priority) return task;
  const ts = nowIso();
  await db.batch([
    {
      sql: 'UPDATE tasks SET priority = ?, updated_at = ? WHERE id = ?',
      params: [priority, ts, taskId],
    },
    eventStatement({
      taskId,
      actorMemberId,
      kind: 'priority_change',
      body: `${task.priority} -> ${priority}`,
      createdAt: ts,
    }),
  ]);
  return { ...task, priority, updated_at: ts };
}

export async function addComment(
  db: Db,
  taskId: string,
  actorMemberId: string | null,
  body: string,
): Promise<TaskEvent> {
  const text = body.trim();
  if (!text) throw new UserError('Empty comment.');
  await getTask(db, taskId);
  const ts = nowIso();
  const stmt = eventStatement({
    taskId,
    actorMemberId,
    kind: 'comment',
    body: text,
    createdAt: ts,
  });
  await db.batch([stmt, { sql: 'UPDATE tasks SET updated_at = ? WHERE id = ?', params: [ts, taskId] }]);
  return {
    id: String(stmt.params?.[0]),
    task_id: taskId,
    actor_member_id: actorMemberId,
    kind: 'comment',
    from_state: null,
    to_state: null,
    body: text,
    created_at: ts,
  };
}

export async function editTask(
  db: Db,
  taskId: string,
  patch: { title?: string; description?: string | null; dueAt?: string | null },
  actorMemberId: string | null,
): Promise<Task> {
  const task = await getTask(db, taskId);
  const sets: string[] = [];
  const params: SqlParam[] = [];
  if (patch.title !== undefined && patch.title.trim()) {
    sets.push('title = ?');
    params.push(patch.title.trim());
  }
  if (patch.description !== undefined) {
    sets.push('description = ?');
    params.push(patch.description?.trim() || null);
  }
  if (patch.dueAt !== undefined) {
    sets.push('due_at = ?');
    params.push(patch.dueAt);
  }
  if (sets.length === 0) return task;
  const ts = nowIso();
  await db.batch([
    {
      sql: `UPDATE tasks SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`,
      params: [...params, ts, taskId],
    },
    eventStatement({ taskId, actorMemberId, kind: 'edited', body: null, createdAt: ts }),
  ]);
  return getTask(db, taskId);
}

export interface TaskFilter {
  familyId: string;
  listIds?: string[];
  assignedTo?: string;
  /** Any of several owners, for a guardian seeing their dependents' work. */
  assignedToAny?: string[];
  /** Include group/unassigned tasks alongside assignedTo. */
  includeUnclaimed?: boolean;
  /** Only group/unassigned tasks. */
  unclaimedOnly?: boolean;
  /** Only tasks hanging on somebody outside the family. */
  waitingOnly?: boolean;
  /** ISO timestamp; only tasks closed since then. Implies closed states. */
  closedAfter?: string;
  states?: readonly TaskState[];
  search?: string;
  limit?: number;
}

/** Fetch specific tasks in the order asked for, silently skipping any that
 *  have since been deleted. Used to redraw a message from its recorded view. */
export async function tasksByIds(db: Db, ids: string[]): Promise<TaskView[]> {
  if (ids.length === 0) return [];
  const rows = await db.all<TaskView>(
    `${VIEW_SELECT} WHERE t.id IN (${ids.map(() => '?').join(', ')})`,
    ids,
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter((t): t is TaskView => Boolean(t));
}

export async function queryTasks(db: Db, filter: TaskFilter): Promise<TaskView[]> {
  const where = ['t.family_id = ?'];
  const params: SqlParam[] = [filter.familyId];

  const states = filter.states ?? (filter.closedAfter ? CLOSED_STATES : OPEN_STATES);
  where.push(`t.state IN (${states.map(() => '?').join(', ')})`);
  params.push(...states);

  if (filter.listIds) {
    if (filter.listIds.length === 0) return [];
    where.push(`t.list_id IN (${filter.listIds.map(() => '?').join(', ')})`);
    params.push(...filter.listIds);
  }
  if (filter.closedAfter) {
    where.push('t.closed_at IS NOT NULL AND t.closed_at >= ?');
    params.push(filter.closedAfter);
  }
  if (filter.waitingOnly) {
    where.push("t.waiting_on IS NOT NULL AND t.waiting_on != ''");
  }
  if (filter.assignedToAny) {
    if (filter.assignedToAny.length === 0) return [];
    where.push(`t.assigned_to IN (${filter.assignedToAny.map(() => '?').join(', ')})`);
    params.push(...filter.assignedToAny);
  }
  if (filter.unclaimedOnly) {
    where.push("t.assignee_kind IN ('group', 'unassigned')");
  } else if (filter.assignedTo) {
    if (filter.includeUnclaimed) {
      where.push("(t.assigned_to = ? OR t.assignee_kind IN ('group', 'unassigned'))");
    } else {
      where.push('t.assigned_to = ?');
    }
    params.push(filter.assignedTo);
  }
  if (filter.search) {
    where.push('(t.title LIKE ? OR t.description LIKE ?)');
    params.push(`%${filter.search}%`, `%${filter.search}%`);
  }

  // Finished work reads as a timeline, newest first; open work reads by
  // what was touched last.
  const order = filter.closedAfter ? 't.closed_at DESC' : 't.updated_at DESC';
  return db.all<TaskView>(
    `${VIEW_SELECT} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ?`,
    [...params, filter.limit ?? 100],
  );
}

/** Rank by urgency rather than recency. `shownCounts` demotes tasks a
 *  member has already seen in past digests. */
export function rankTasks(
  tasks: TaskView[],
  opts: { now?: Date; shownCounts?: Map<string, number> } = {},
): TaskView[] {
  const now = opts.now ?? new Date();
  return [...tasks].sort(
    (a, b) =>
      rankScore(b, { now, timesShown: opts.shownCounts?.get(b.id) ?? 0 }) -
      rankScore(a, { now, timesShown: opts.shownCounts?.get(a.id) ?? 0 }),
  );
}

function eventStatement(e: {
  taskId: string;
  actorMemberId: string | null;
  kind: TaskEvent['kind'];
  fromState?: TaskState | null;
  toState?: TaskState | null;
  body: string | null;
  createdAt: string;
}) {
  return {
    sql: `INSERT INTO task_events (id, task_id, actor_member_id, kind, from_state, to_state, body, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [
      newId('evt'),
      e.taskId,
      e.actorMemberId,
      e.kind,
      e.fromState ?? null,
      e.toState ?? null,
      e.body,
      e.createdAt,
    ] as SqlParam[],
  };
}
