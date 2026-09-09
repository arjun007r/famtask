import type { Db } from '../db/adapter.ts';
import { newId, nowIso } from '../ids.ts';
import { UserError } from '../errors.ts';
import type { FamilyMember, TaskList } from '../types.ts';

export const DEFAULT_LIST_NAME = 'Family';
/** How many lists feed a person's daily digest. Confirmed with the owner. */
export const MAX_DIGEST_LISTS = 3;

export async function createList(
  db: Db,
  input: { familyId: string; name: string; ownerMemberId?: string | null },
): Promise<TaskList> {
  const name = input.name.trim();
  if (!name) throw new UserError('A list needs a name.');
  const existing = await findListByName(db, input.familyId, name);
  if (existing) throw new UserError(`There is already a list called "${existing.name}".`);
  const list: TaskList = {
    id: newId('lst'),
    family_id: input.familyId,
    name,
    owner_member_id: input.ownerMemberId ?? null,
    created_at: nowIso(),
    archived_at: null,
  };
  await db.run(
    'INSERT INTO lists (id, family_id, name, owner_member_id, created_at, archived_at) VALUES (?, ?, ?, ?, ?, NULL)',
    [list.id, list.family_id, list.name, list.owner_member_id, list.created_at],
  );
  return list;
}

export async function findListByName(
  db: Db,
  familyId: string,
  name: string,
): Promise<TaskList | null> {
  return db.first<TaskList>(
    'SELECT * FROM lists WHERE family_id = ? AND lower(name) = lower(?) AND archived_at IS NULL',
    [familyId, name.trim()],
  );
}

export async function getList(db: Db, id: string): Promise<TaskList> {
  const row = await db.first<TaskList>('SELECT * FROM lists WHERE id = ?', [id]);
  if (!row) throw new UserError('List not found.');
  return row;
}

/** Shared lists plus the member's own personal lists. */
export async function listsVisibleTo(db: Db, member: FamilyMember): Promise<TaskList[]> {
  return db.all<TaskList>(
    `SELECT * FROM lists
      WHERE family_id = ? AND archived_at IS NULL
        AND (owner_member_id IS NULL OR owner_member_id = ?)
      ORDER BY owner_member_id IS NOT NULL, name`,
    [member.family_id, member.id],
  );
}

export async function allLists(db: Db, familyId: string): Promise<TaskList[]> {
  return db.all<TaskList>(
    'SELECT * FROM lists WHERE family_id = ? AND archived_at IS NULL ORDER BY name',
    [familyId],
  );
}

/**
 * Resolve the list a task belongs to. A name the family has not used before
 * is created on the spot -- any member can create a list, and making them
 * run a command first would lose the task.
 */
export async function resolveList(
  db: Db,
  familyId: string,
  name: string | null | undefined,
): Promise<TaskList> {
  if (name && name.trim()) {
    const found = await findListByName(db, familyId, name);
    if (found) return found;
    return createList(db, { familyId, name });
  }
  const fallback = await findListByName(db, familyId, DEFAULT_LIST_NAME);
  return fallback ?? createList(db, { familyId, name: DEFAULT_LIST_NAME });
}

/**
 * The lists that feed this member's daily digest.
 *
 * <= MAX_DIGEST_LISTS visible lists: all of them, no setting needed.
 * More than that: their explicit pick, capped. If they have not picked yet
 * we fall back to the lists with the most open tasks so the digest is
 * never empty, and prompt them to choose.
 */
export async function digestListsFor(
  db: Db,
  member: FamilyMember,
): Promise<{ lists: TaskList[]; needsChoice: boolean }> {
  const visible = await listsVisibleTo(db, member);
  if (visible.length <= MAX_DIGEST_LISTS) return { lists: visible, needsChoice: false };

  const picked = await db.all<TaskList>(
    `SELECT l.* FROM member_digest_lists d
       JOIN lists l ON l.id = d.list_id
      WHERE d.member_id = ? AND l.archived_at IS NULL
      ORDER BY d.position
      LIMIT ?`,
    [member.id, MAX_DIGEST_LISTS],
  );
  if (picked.length > 0) return { lists: picked, needsChoice: false };

  const busiest = await db.all<TaskList>(
    `SELECT l.*, COUNT(t.id) AS open_count FROM lists l
       LEFT JOIN tasks t ON t.list_id = l.id AND t.state NOT IN ('done','cancelled')
      WHERE l.family_id = ? AND l.archived_at IS NULL
        AND (l.owner_member_id IS NULL OR l.owner_member_id = ?)
      GROUP BY l.id
      ORDER BY open_count DESC, l.name
      LIMIT ?`,
    [member.family_id, member.id, MAX_DIGEST_LISTS],
  );
  return { lists: busiest, needsChoice: true };
}

export async function setDigestLists(db: Db, memberId: string, listIds: string[]): Promise<void> {
  if (listIds.length > MAX_DIGEST_LISTS) {
    throw new UserError(`Pick at most ${MAX_DIGEST_LISTS} lists for your daily digest.`);
  }
  await db.batch([
    { sql: 'DELETE FROM member_digest_lists WHERE member_id = ?', params: [memberId] },
    ...listIds.map((listId, i) => ({
      sql: 'INSERT INTO member_digest_lists (member_id, list_id, position) VALUES (?, ?, ?)',
      params: [memberId, listId, i] as (string | number)[],
    })),
  ]);
}

/** Toggle one list in/out of the member's digest picks. Returns the new set. */
export async function toggleDigestList(
  db: Db,
  member: FamilyMember,
  listId: string,
): Promise<{ lists: TaskList[]; atCap: boolean }> {
  const current = await db.all<{ list_id: string }>(
    'SELECT list_id FROM member_digest_lists WHERE member_id = ? ORDER BY position',
    [member.id],
  );
  const ids = current.map((r) => r.list_id);
  let atCap = false;
  let next: string[];
  if (ids.includes(listId)) {
    next = ids.filter((id) => id !== listId);
  } else if (ids.length >= MAX_DIGEST_LISTS) {
    atCap = true;
    next = ids;
  } else {
    next = [...ids, listId];
  }
  if (!atCap) await setDigestLists(db, member.id, next);
  const { lists } = await digestListsFor(db, member);
  return { lists, atCap };
}
