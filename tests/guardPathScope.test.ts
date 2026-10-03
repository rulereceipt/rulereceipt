import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardDecision } from "../src/guard.js";

/**
 * The guard must honour path scope. A subfolder rules file (discovered 0.1.88)
 * governs only its own subtree; the guard was applying every forbid globally, so
 * a rule scoped to `sub/**` blocked an action OUTSIDE sub/ — a false-block, the
 * live-blocking equivalent of a false accusation (it bit this repo: a demo
 * `z_gallery/**` rule blocked an edit to `src/`). `check` already path-scopes;
 * the guard now does too.
 *
 * Uses a codeContent rule (a banned call written into a file) rather than a
 * file-path rule, because the delete/modify gate exempts scratch paths like the
 * test's own tmp dir, which would mask a file-path block.
 */
let dir: string;
const CALL = "analytics.track(42)"; // matches a "never call `analytics.track(`" rule
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rr-guard-scope-"));
  mkdirSync(join(dir, "sub"), { recursive: true });
  writeFileSync(join(dir, "sub", "CLAUDE.md"), "## No track\nNever call `analytics.track(` in code.\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("guard respects a subfolder rule's subtree scope", () => {
  it("BLOCKS a matching write INSIDE the rule's subtree", () => {
    const d = guardDecision(dir, "Write", { file_path: join(dir, "sub", "a.js"), content: CALL });
    expect(d.deny).toBe(true);
  });

  it("does NOT block a matching write OUTSIDE the subtree (the false-block fix)", () => {
    const d = guardDecision(dir, "Write", { file_path: join(dir, "a.js"), content: CALL });
    expect(d.deny).toBe(false);
  });

  it("an UNSCOPED (top-level) rule still applies everywhere", () => {
    writeFileSync(join(dir, "CLAUDE.md"), "## No track\nNever call `analytics.track(` in code.\n");
    const d = guardDecision(dir, "Write", { file_path: join(dir, "a.js"), content: CALL });
    expect(d.deny).toBe(true);
  });
});
