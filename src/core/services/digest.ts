import type { Db } from '../db/adapter.ts';
import { newId, nowIso } from '../ids.ts';
import type { FamilyMember, TaskList, TaskView } from '../types.ts';
import { digestListsFor } from './lists.ts';
import { queryTasks, rankTasks } from './tasks.ts';

export const DIGEST_SIZE = 5;
/** Cap on the unclaimed tail so the DM stays readable. */
export const UNCLAIMED_TAIL = 3;

export interface Digest {
  member: FamilyMember;
  lists: TaskList[];
  /** They have more lists than the digest holds and have not picked yet. */
  needsListChoice: boolean;
  items: TaskView[];
  /** Group/unassigned tasks, shown after their own so nothing gets lost. */
  unclaimed: TaskView[];
  isEmpty: boolean;
}

export async function buildDigest(
  db: Db,
  member: FamilyMember,
  opts: { now?: Date; limit?: number } = {},
): Promise<Digest> {
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? DIGEST_SIZE;
  const { lists, needsChoice } = await digestListsFor(db, member);
  const listIds = lists.map((l) => l.id);

  const shownCounts = await digestShownCounts(db, member.id);

  const mine = await queryTasks(db, {
    familyId: member.family_id,
    listIds,
    assignedTo: member.id,
  });
  const items = rankTasks(mine, { now, shownCounts }).slice(0, limit);

  const openToAll = await queryTasks(db, {
    familyId: member.family_id,
    listIds,
    unclaimedOnly: true,
  });
  const unclaimed = rankTasks(openToAll, { now, shownCounts }).slice(0, UNCLAIMED_TAIL);

  return {
    member,
    lists,
    needsListChoice: needsChoice,
    items,
    unclaimed,
    isEmpty: items.length === 0 && unclaimed.length === 0,
  };
}

/** How many past digests each task has appeared in, for this member. */
export async function digestShownCounts(db: Db, memberId: string): Promise<Map<string, number>> {
  const rows = await db.all<{ task_id: string; n: number }>(
    'SELECT task_id, COUNT(*) AS n FROM digest_sends WHERE member_id = ? GROUP BY task_id',
    [memberId],
  );
  return new Map(rows.map((r) => [r.task_id, Number(r.n)]));
}

export async function recordDigestSends(
  db: Db,
  memberId: string,
  taskIds: string[],
  sentOn: string,
): Promise<void> {
  if (taskIds.length === 0) return;
  const ts = nowIso();
  await db.batch(
    taskIds.map((taskId) => ({
      sql: `INSERT OR IGNORE INTO digest_sends (id, member_id, task_id, sent_on, created_at)
            VALUES (?, ?, ?, ?, ?)`,
      params: [newId('dsd'), memberId, taskId, sentOn, ts],
    })),
  );
}

export async function alreadySentToday(
  db: Db,
  memberId: string,
  localDate: string,
): Promise<boolean> {
  const row = await db.first<{ n: number }>(
    'SELECT COUNT(*) AS n FROM digest_sends WHERE member_id = ? AND sent_on = ?',
    [memberId, localDate],
  );
  return Number(row?.n ?? 0) > 0;
}

/** Unclaimed work for the shared group post. Family-wide, not per-member,
 *  so it ignores digest list picks. */
export async function buildGroupBoard(
  db: Db,
  familyId: string,
  opts: { now?: Date; limit?: number } = {},
): Promise<TaskView[]> {
  const open = await queryTasks(db, { familyId, unclaimedOnly: true });
  return rankTasks(open, { now: opts.now }).slice(0, opts.limit ?? DIGEST_SIZE);
}

/** Members whose local clock has just reached their digest hour. The cron
 *  fires hourly and this decides who is actually due, which is what makes
 *  per-person digest times work off a single trigger. */
export function membersDueNow(members: FamilyMember[], now: Date): FamilyMember[] {
  return members.filter(
    (m) => m.telegram_chat_id && localHour(m.timezone, now) === m.digest_hour,
  );
}

export function localHour(timezone: string, now: Date): number {
  const parts = formatter(timezone, { hour: '2-digit', hour12: false }).format(now);
  return Number.parseInt(parts, 10);
}

/** YYYY-MM-DD in the member's own timezone. */
export function localDate(timezone: string, now: Date): string {
  return formatter(timezone, { year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

function formatter(timezone: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat('en-CA', { ...opts, timeZone: timezone });
  } catch {
    return new Intl.DateTimeFormat('en-CA', { ...opts, timeZone: 'UTC' });
  }
}
