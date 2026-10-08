import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { guardDecision } from "../src/guard.js";
import { loadRules } from "../src/rules.js";
import { classifyRules } from "../src/checks/classify.js";

/**
 * A "never wipe the database" rule must match only REAL data-destroying commands,
 * never version-control/image/package deletes. Real incident 2026-10-08: the guard
 * blocked `git branch -d` as a data wipe. Tracked in the FA corpus (v3) too.
 */
let dir = "";
beforeEach(() => {
  // Under homedir, NOT tmpdir: loadRules skips rule files on throwaway paths
  // (/tmp, /var/folders), so a tmpdir-based test silently loads 0 rules and the
  // guard allows everything — which is how the first cut of this test passed
  // locally (the machine's own ~/.claude/CLAUDE.md supplied the rule) yet failed
  // in CI. The sanity check below makes that failure mode loud, not silent.
  dir = mkdtempSync(join(homedir(), ".rr-delfp-"));
  mkdirSync(join(dir, ".git"));
  // Must be phrased so it classifies as a delete APPROVAL-GATE (verb + "without
  // asking") — a terse "Never wipe the database." classifies as a judgment rule
  // and the delete gate never engages, which hid the CI failure behind the
  // machine's rich global Rule 16. The sanity test below pins the classification.
  writeFileSync(join(dir, "CLAUDE.md"), "- Never wipe or delete data storage databases without asking me first.\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it("sanity: the rule loads from the test dir AND classifies as a delete approval-gate", () => {
  const loaded = loadRules(dir).filter((r) => /wipe or delete data storage/i.test(r.title));
  expect(loaded.length).toBeGreaterThan(0);
  const cls = classifyRules(loaded) as { kind: string; actions?: string[] }[];
  expect(cls.some((c) => c.kind === "approvalGate" && (c.actions ?? []).includes("delete"))).toBe(true);
});

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
