import type { Db } from '../db/adapter.ts';
import { nowIso } from '../ids.ts';

export async function getState(db: Db, key: string): Promise<string | null> {
  const row = await db.first<{ value: string }>('SELECT value FROM app_state WHERE key = ?', [key]);
  return row?.value ?? null;
}

export async function setState(db: Db, key: string, value: string): Promise<void> {
  await db.run(
    `INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, value, nowIso()],
  );
}

/** True the first time it is called with a given key/stamp pair. */
export async function claimOnce(db: Db, key: string, stamp: string): Promise<boolean> {
  if ((await getState(db, key)) === stamp) return false;
  await setState(db, key, stamp);
  return true;
}
