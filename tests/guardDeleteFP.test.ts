import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { guardDecision } from "../src/guard.js";

/**
 * A "never wipe the database" rule must match only REAL data-destroying commands,
 * never version-control/image/package deletes. Real incident 2026-10-08: the guard
 * blocked `git branch -d` as a data wipe. Tracked in the FA corpus (v3) too.
 */
let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rr-delfp-"));
  mkdirSync(join(dir, ".git"));
  writeFileSync(join(dir, "CLAUDE.md"), "- Never wipe data storage databases.\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// In a no-prompt mode (auto/bypass) — the mode the hook actually runs in — a
// gated delete comes back deny:true; a benign one comes back allow. This is the
// exact path that blocked `git branch -d` on 2026-10-08.
const dataWipeBlocked = (command: string): boolean =>
  guardDecision(dir, "Bash", { command }, [], "bypassPermissions").deny;

describe("guard: data-wipe rule does NOT fire on VCS/image/package deletes", () => {
  // The branch/tag NAMES here contain data-store words (data, db, storage) on
  // purpose: that substring + the old `git …-D` delete pattern is exactly what
  // made the guard read a branch delete as a database wipe on 2026-10-08.
  for (const command of ["git branch -d feat/x", "git branch -D feat/x", "git branch -d data-migration", "git branch -D db-reindex", "git tag -d v1.0", "git tag -d storage-snapshot", "git worktree remove wt", "git stash drop", "git stash clear", "docker rmi myimage:1", "docker image rm sha256:abc", "npm uninstall left-pad", "pnpm remove foo"]) {
    it(`allows: ${command}`, () => {
      expect(dataWipeBlocked(command)).toBe(false);
    });
  }
});

describe("guard: data-wipe rule STILL fires on real data-destroying commands", () => {
  for (const command of ["rm data/app.db", "rm -f storage/ledger.sqlite", "dropdb production", "redis-cli FLUSHALL", "DROP TABLE users", "truncate table events"]) {
    it(`flags: ${command}`, () => {
      expect(dataWipeBlocked(command)).toBe(true);
    });
  }
});

/**
 * KNOWN LIMITATION (pre-existing, not introduced here): a destroy verb carried
 * INSIDE a quoted argument — `psql -c 'DROP TABLE users'` — is blanked by the
 * same quote-stripping that stops `echo "git push"` being a false push, so the
 * guard does not see it. Widening detection into quoted SQL args risks new false
 * positives, so it is deferred to a shadow-mode + FA pass (see KNOWN-GAPS). These
 * cases are pinned as NOT-caught so a future change to that behaviour is visible.
 */
describe("guard: known limitation — destroy verb hidden in a quoted arg is not seen", () => {
  for (const command of ["psql -c 'DROP TABLE users'", "mysql -e 'DROP DATABASE prod'"]) {
    it(`not yet flagged: ${command}`, () => {
      expect(dataWipeBlocked(command)).toBe(false);
    });
  }
});
