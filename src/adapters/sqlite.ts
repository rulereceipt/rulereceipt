import { createRequire } from "node:module";

/**
 * Shared, read-only `node:sqlite` helper for the db-backed session adapters.
 *
 * `node:sqlite` is Node 22.5+ and experimental, so Node 22/23 prints a one-time
 * "SQLite is an experimental feature" ExperimentalWarning the first time it is
 * required. This loads it LAZILY (only when a db actually needs reading) and
 * mutes exactly that one warning — every other warning passes straight through.
 * An older Node (<22.5) that lacks the module degrades (the caller skips those
 * sessions, noting it once) instead of crashing.
 *
 * opencode.ts carries its own copy of this pattern (it shipped first, and is
 * validated end-to-end); the Devin adapter uses this shared one. Kept separate
 * on purpose so a refactor here can never regress the shipped OpenCode path.
 */

export interface SqliteDb {
  all(sql: string, ...params: unknown[]): Record<string, unknown>[];
  close(): void;
}

/** Require node:sqlite, muting ONLY its own experimental warning. */
function loadSqlite(): ((path: string) => SqliteDb) | undefined {
  const origEmit = process.emitWarning.bind(process);
  (process as unknown as { emitWarning: typeof process.emitWarning }).emitWarning = ((warning: string | Error, ...rest: unknown[]): void => {
    const opt = rest[0];
    const type = typeof opt === "string" ? opt : (opt && typeof opt === "object" ? (opt as { type?: string }).type : undefined);
    const msg = typeof warning === "string" ? warning : warning?.message;
    if (type === "ExperimentalWarning" && typeof msg === "string" && /sqlite/i.test(msg)) return;
    (origEmit as (...a: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    const req = createRequire(import.meta.url);
    const { DatabaseSync } = req("node:sqlite") as { DatabaseSync: new (p: string, o?: { readOnly?: boolean }) => { prepare(sql: string): { all(...p: unknown[]): unknown[] }; close(): void } };
    return (path: string) => {
      const db = new DatabaseSync(path, { readOnly: true });
      return {
        all: (sql, ...params) => db.prepare(sql).all(...params) as Record<string, unknown>[],
        close: () => db.close(),
      };
    };
  } catch {
    return undefined;
  } finally {
    process.emitWarning = origEmit;
  }
}

let sqliteResolved = false;
let sqliteOpener: ((path: string) => SqliteDb) | undefined;
/** Lazy, memoised node:sqlite opener. `RR_FORCE_NO_SQLITE=1` forces the
 * old-Node degraded path (used by tests, and a usable escape hatch). */
export function getSqlite(): ((path: string) => SqliteDb) | undefined {
  if (/^(1|true|yes)$/i.test(process.env.RR_FORCE_NO_SQLITE ?? "")) return undefined;
  if (sqliteResolved) return sqliteOpener;
  sqliteResolved = true;
  sqliteOpener = loadSqlite();
  return sqliteOpener;
}

/** The exact stderr line shown when this Node can't read an agent's db. */
export function sqliteUnavailableWarning(agent: string): string {
  return `rulereceipt: reading ${agent} sessions needs Node 22.5+ (this is Node ${process.versions.node}); skipping ${agent}'s database. Upgrade Node to include them.`;
}
