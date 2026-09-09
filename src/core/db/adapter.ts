/**
 * The only database surface the core engine is allowed to use. Backed by
 * Cloudflare D1 in production and by node:sqlite in tests and the CLI, so
 * the engine is runnable without deploying anything.
 */
export type SqlParam = string | number | null;

export interface Statement {
  sql: string;
  params?: SqlParam[];
}

export interface Db {
  all<T>(sql: string, params?: SqlParam[]): Promise<T[]>;
  first<T>(sql: string, params?: SqlParam[]): Promise<T | null>;
  run(sql: string, params?: SqlParam[]): Promise<void>;
  /** Applied atomically where the driver supports it. */
  batch(statements: Statement[]): Promise<void>;
}

/** Minimal structural view of D1, so this file needs no Workers types. */
interface D1Like {
  prepare(sql: string): {
    bind(...params: SqlParam[]): {
      all<T>(): Promise<{ results: T[] }>;
      first<T>(): Promise<T | null>;
      run(): Promise<unknown>;
    };
  };
  batch(stmts: unknown[]): Promise<unknown>;
}

export function d1Adapter(d1: D1Like): Db {
  const bind = (sql: string, params: SqlParam[] = []) => d1.prepare(sql).bind(...params);
  return {
    async all<T>(sql: string, params?: SqlParam[]) {
      const { results } = await bind(sql, params).all<T>();
      return results ?? [];
    },
    async first<T>(sql: string, params?: SqlParam[]) {
      return await bind(sql, params).first<T>();
    },
    async run(sql: string, params?: SqlParam[]) {
      await bind(sql, params).run();
    },
    async batch(statements: Statement[]) {
      if (statements.length === 0) return;
      await d1.batch(statements.map((s) => bind(s.sql, s.params)));
    },
  };
}
