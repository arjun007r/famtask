/**
 * Pushes tasks to an external target and remembers what it pushed.
 *
 * Reconcile rather than fire-on-write: a hash of the mirrored shape is
 * stored alongside the external id, so a sweep skips everything unchanged
 * and costs one query. That makes it cheap enough to run after each message
 * *and* on the cron, which means a failed push heals on the next pass
 * instead of silently losing a task.
 */
import type { Db } from '../db/adapter.ts';
import { nowIso } from '../ids.ts';
import { effectivePriority } from '../priority.ts';
import { isClosed } from '../state-machine.ts';
import type { MirroredTask, SyncTarget } from '../../sync/types.ts';
import type { Priority, TaskState } from '../types.ts';

interface Row {
  id: string;
  title: string;
  description: string | null;
  list_name: string;
  assignee_name: string | null;
  state: TaskState;
  priority: Priority;
  due_at: string | null;
  external_id: string | null;
  synced_hash: string | null;
}

export interface SyncReport {
  created: number;
  updated: number;
  closed: number;
  reopened: number;
  failed: number;
  skipped: number;
}

const EMPTY: SyncReport = { created: 0, updated: 0, closed: 0, reopened: 0, failed: 0, skipped: 0 };

export async function reconcile(
  db: Db,
  target: SyncTarget,
  familyId: string,
  opts: { limit?: number; now?: Date } = {},
): Promise<SyncReport> {
  const rows = await db.all<Row>(
    `SELECT t.id, t.title, t.description, t.state, t.priority, t.due_at,
            l.name AS list_name, m.name AS assignee_name,
            s.external_id, s.synced_hash
       FROM tasks t
       JOIN lists l ON l.id = t.list_id
       LEFT JOIN family_members m ON m.id = t.assigned_to
       LEFT JOIN sync_links s ON s.task_id = t.id AND s.target = ?
      WHERE t.family_id = ?
      ORDER BY t.updated_at DESC
      LIMIT ?`,
    [target.name, familyId, opts.limit ?? 200],
  );

  const report: SyncReport = { ...EMPTY };
  const now = opts.now ?? new Date();

  for (const row of rows) {
    const task = toMirrored(row, now);
    const hash = shapeHash(task);

    // Never seen and already finished: nothing worth creating.
    if (!row.external_id && task.closed) {
      report.skipped += 1;
      continue;
    }
    if (row.external_id && row.synced_hash === hash) {
      report.skipped += 1;
      continue;
    }

    try {
      if (!row.external_id) {
        const externalId = await target.create(task);
        await link(db, row.id, target.name, externalId, hash);
        report.created += 1;
        continue;
      }

      const wasClosed = row.synced_hash?.endsWith('|closed') ?? false;
      if (task.closed && !wasClosed) {
        await target.close(row.external_id);
        report.closed += 1;
      } else if (!task.closed && wasClosed) {
        await target.reopen(row.external_id);
        await target.update(row.external_id, task);
        report.reopened += 1;
      } else {
        await target.update(row.external_id, task);
        report.updated += 1;
      }
      await link(db, row.id, target.name, row.external_id, hash);
    } catch (err) {
      // One bad task must not stop the sweep; the next pass retries it,
      // because its hash was never recorded.
      report.failed += 1;
      console.error(`sync ${target.name} failed for ${row.id}`, err);
    }
  }

  return report;
}

function toMirrored(row: Row, now: Date): MirroredTask {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    listName: row.list_name,
    assigneeName: row.assignee_name,
    state: row.state,
    priority: effectivePriority(
      { priority: row.priority, due_at: row.due_at, state: row.state },
      now,
    ),
    dueAt: row.due_at,
    closed: isClosed(row.state),
  };
}

/** Everything the target actually renders. Changing any of it should push;
 *  changing anything else should not. The closed marker is a suffix so the
 *  sweep can tell a close from an edit without a second column. */
export function shapeHash(task: MirroredTask): string {
  const shape = [
    task.title,
    task.description ?? '',
    task.listName,
    task.assigneeName ?? '',
    task.state,
    task.priority,
    task.dueAt ?? '',
  ].join(' ');

  let h = 5381;
  for (let i = 0; i < shape.length; i += 1) {
    h = (Math.imul(h, 33) + shape.charCodeAt(i)) | 0;
  }
  return `${(h >>> 0).toString(36)}|${task.closed ? 'closed' : 'open'}`;
}

async function link(
  db: Db,
  taskId: string,
  target: string,
  externalId: string,
  hash: string,
): Promise<void> {
  await db.run(
    `INSERT INTO sync_links (task_id, target, external_id, synced_hash, synced_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(task_id, target) DO UPDATE SET
       external_id = excluded.external_id,
       synced_hash = excluded.synced_hash,
       synced_at   = excluded.synced_at`,
    [taskId, target, externalId, hash, nowIso()],
  );
}
