import type { Db } from '../db/adapter.ts';
import { newId, nowIso } from '../ids.ts';
import { UserError } from '../errors.ts';
import type { Family, FamilyMember } from '../types.ts';

/** There is exactly one family today; family_id exists so that stays cheap
 *  to change. Everything else in the engine treats it as a real workspace. */
export async function ensureFamily(db: Db, name = 'Family'): Promise<Family> {
  const existing = await db.first<Family>('SELECT * FROM families LIMIT 1');
  if (existing) return existing;
  const family: Family = { id: newId('fam'), name, group_chat_id: null, created_at: nowIso() };
  await db.run('INSERT INTO families (id, name, group_chat_id, created_at) VALUES (?, ?, ?, ?)', [
    family.id,
    family.name,
    null,
    family.created_at,
  ]);
  return family;
}

export async function getFamily(db: Db, familyId: string): Promise<Family> {
  const row = await db.first<Family>('SELECT * FROM families WHERE id = ?', [familyId]);
  if (!row) throw new UserError('Family not found.');
  return row;
}

export async function setGroupChat(db: Db, familyId: string, chatId: string | null): Promise<void> {
  await db.run('UPDATE families SET group_chat_id = ? WHERE id = ?', [chatId, familyId]);
}

export interface AddMemberInput {
  familyId: string;
  name: string;
  telegramUserId: string;
  telegramChatId?: string | null;
  timezone?: string;
  digestHour?: number;
}

export async function addMember(db: Db, input: AddMemberInput): Promise<FamilyMember> {
  const existing = await getMemberByTelegramUserId(db, input.telegramUserId);
  if (existing) throw new UserError(`${existing.name} is already in the family.`);
  const member: FamilyMember = {
    id: newId('mem'),
    family_id: input.familyId,
    name: input.name,
    telegram_user_id: input.telegramUserId,
    telegram_chat_id: input.telegramChatId ?? null,
    timezone: input.timezone ?? 'UTC',
    digest_hour: input.digestHour ?? 9,
    is_active: 1,
    created_at: nowIso(),
  };
  await db.run(
    `INSERT INTO family_members
       (id, family_id, name, telegram_user_id, telegram_chat_id, timezone, digest_hour, is_active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    [
      member.id,
      member.family_id,
      member.name,
      member.telegram_user_id,
      member.telegram_chat_id,
      member.timezone,
      member.digest_hour,
      member.created_at,
    ],
  );
  return member;
}

export async function getMemberByTelegramUserId(
  db: Db,
  telegramUserId: string,
): Promise<FamilyMember | null> {
  return db.first<FamilyMember>('SELECT * FROM family_members WHERE telegram_user_id = ?', [
    telegramUserId,
  ]);
}

export async function getMember(db: Db, id: string): Promise<FamilyMember> {
  const row = await db.first<FamilyMember>('SELECT * FROM family_members WHERE id = ?', [id]);
  if (!row) throw new UserError('Family member not found.');
  return row;
}

export async function listMembers(db: Db, familyId: string): Promise<FamilyMember[]> {
  return db.all<FamilyMember>(
    'SELECT * FROM family_members WHERE family_id = ? AND is_active = 1 ORDER BY name',
    [familyId],
  );
}

/** Learn a member's DM chat id the first time they talk to the bot. */
export async function rememberChatId(db: Db, memberId: string, chatId: string): Promise<void> {
  await db.run('UPDATE family_members SET telegram_chat_id = ? WHERE id = ?', [chatId, memberId]);
}

export async function updateMemberPrefs(
  db: Db,
  memberId: string,
  prefs: { timezone?: string; digestHour?: number },
): Promise<void> {
  if (prefs.timezone !== undefined) {
    await db.run('UPDATE family_members SET timezone = ? WHERE id = ?', [prefs.timezone, memberId]);
  }
  if (prefs.digestHour !== undefined) {
    if (!Number.isInteger(prefs.digestHour) || prefs.digestHour < 0 || prefs.digestHour > 23) {
      throw new UserError('Digest hour must be a whole number from 0 to 23.');
    }
    await db.run('UPDATE family_members SET digest_hour = ? WHERE id = ?', [
      prefs.digestHour,
      memberId,
    ]);
  }
}

/** Resolve a free-text name ("ask Priya to...") to a member of the family. */
export function matchMemberByName(members: FamilyMember[], name: string): FamilyMember | null {
  const needle = name.trim().toLowerCase().replace(/^@/, '');
  if (!needle) return null;
  return (
    members.find((m) => m.name.toLowerCase() === needle) ??
    members.find((m) => m.name.toLowerCase().split(/\s+/)[0] === needle) ??
    members.find((m) => m.telegram_user_id === needle) ??
    null
  );
}
