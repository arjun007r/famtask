import type { Db } from '../db/adapter.ts';
import { newId, nowIso } from '../ids.ts';
import { UserError } from '../errors.ts';
import type { Family, FamilyMember } from '../types.ts';

/** There is exactly one family today; family_id exists so that stays cheap
 *  to change. Everything else in the engine treats it as a real workspace. */
export async function ensureFamily(db: Db, name = 'Family'): Promise<Family> {
  const existing = await db.first<Family>('SELECT * FROM families LIMIT 1');
  if (existing) return existing;
  const family: Family = {
    id: newId('fam'),
    name,
    group_chat_id: null,
    group_chat_channel: null,
    created_at: nowIso(),
  };
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

export async function setGroupChat(
  db: Db,
  familyId: string,
  chatId: string | null,
  channel: string | null = null,
): Promise<void> {
  await db.run('UPDATE families SET group_chat_id = ?, group_chat_channel = ? WHERE id = ?', [
    chatId,
    chatId ? channel : null,
    familyId,
  ]);
}

/** Reserved channel for a member with no device at all. */
export const OFFLINE_CHANNEL = 'offline';

export interface AddMemberInput {
  familyId: string;
  name: string;
  /** Defaults to Telegram, which is the only channel that predates this field. */
  channel?: string;
  /** Omitted only for an offline member, who has no id anywhere to use. */
  channelUserId?: string;
  channelChatId?: string | null;
  /** Required for an offline member: who sees their tasks for them. */
  guardianMemberId?: string | null;
  timezone?: string;
  digestHour?: number;
}

export function isOffline(member: FamilyMember): boolean {
  return member.channel === OFFLINE_CHANNEL;
}

export async function addMember(db: Db, input: AddMemberInput): Promise<FamilyMember> {
  const channel = input.channel ?? 'telegram';
  const offline = channel === OFFLINE_CHANNEL;
  if (!offline && !input.channelUserId) {
    throw new UserError(`I need their ${channel} id to be able to message them.`);
  }
  // Nothing outside famtask identifies an offline member, so the id is ours.
  const channelUserId = input.channelUserId ?? newId('off');
  const existing = await getMemberByChannelId(db, channel, channelUserId);
  if (existing) throw new UserError(`${existing.name} is already in the family.`);
  const member: FamilyMember = {
    id: newId('mem'),
    family_id: input.familyId,
    name: input.name,
    channel,
    channel_user_id: channelUserId,
    channel_chat_id: offline ? null : input.channelChatId ?? null,
    guardian_member_id: input.guardianMemberId ?? null,
    timezone: input.timezone ?? 'UTC',
    digest_hour: input.digestHour ?? 9,
    is_active: 1,
    created_at: nowIso(),
  };
  await db.run(
    `INSERT INTO family_members
       (id, family_id, name, channel, channel_user_id, channel_chat_id, guardian_member_id,
        timezone, digest_hour, is_active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    [
      member.id,
      member.family_id,
      member.name,
      member.channel,
      member.channel_user_id,
      member.channel_chat_id,
      member.guardian_member_id,
      member.timezone,
      member.digest_hour,
      member.created_at,
    ],
  );
  return member;
}

/** Ids are only unique within a channel, so both halves are the key. */
export async function getMemberByChannelId(
  db: Db,
  channel: string,
  channelUserId: string,
): Promise<FamilyMember | null> {
  return db.first<FamilyMember>(
    'SELECT * FROM family_members WHERE channel = ? AND channel_user_id = ?',
    [channel, channelUserId],
  );
}

/** Members this person sees the tasks of, because those members have no
 *  device of their own. */
export async function listDependents(db: Db, guardianId: string): Promise<FamilyMember[]> {
  return db.all<FamilyMember>(
    'SELECT * FROM family_members WHERE guardian_member_id = ? AND is_active = 1 ORDER BY name',
    [guardianId],
  );
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
  await db.run('UPDATE family_members SET channel_chat_id = ? WHERE id = ?', [chatId, memberId]);
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
    members.find((m) => m.channel_user_id === needle) ??
    null
  );
}
