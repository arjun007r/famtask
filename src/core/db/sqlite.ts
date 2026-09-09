/** node:sqlite adapter -- tests and the local CLI only. Never imported by
 *  Worker code. */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Db, SqlParam, Statement } from './adapter.ts';

export function sqliteAdapter(db: DatabaseSync): Db {
  const p = (params: SqlParam[] = []) => params as (string | number | null)[];
  return {
    async all<T>(sql: string, params?: SqlParam[]) {
      return db.prepare(sql).all(...p(params)) as T[];
    },
    async first<T>(sql: string, params?: SqlParam[]) {
      return (db.prepare(sql).get(...p(params)) as T | undefined) ?? null;
    },
    async run(sql: string, params?: SqlParam[]) {
      db.prepare(sql).run(...p(params));
    },
    async batch(statements: Statement[]) {
      if (statements.length === 0) return;
      db.exec('BEGIN');
      try {
        for (const s of statements) db.prepare(s.sql).run(...p(s.params));
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
  };
}

/** Fresh in-memory database with every migration applied. */
export function memoryDb(migrationsDir = 'migrations'): { db: Db; raw: DatabaseSync } {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');
  for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(join(migrationsDir, file), 'utf8'));
  }
  return { db: sqliteAdapter(raw), raw };
}

/** File-backed database for the local CLI. Applies any migration whose
 *  filename is not yet recorded, so re-running is safe. */
export function fileDb(path: string, migrationsDir = 'migrations'): { db: Db; raw: DatabaseSync } {
  const raw = new DatabaseSync(path);
  raw.exec('PRAGMA foreign_keys = ON');
  raw.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set(
    (raw.prepare('SELECT name FROM _migrations').all() as { name: string }[]).map((r) => r.name),
  );
  for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()) {
    if (applied.has(file)) continue;
    raw.exec(readFileSync(join(migrationsDir, file), 'utf8'));
    raw.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(
      file,
      new Date().toISOString(),
    );
  }
  return { db: sqliteAdapter(raw), raw };
}
