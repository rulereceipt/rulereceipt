import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardDecision } from "../src/guard.js";
import { checkSessionInBrowser } from "../src/browser/evaluateBrowser.js";

/**
 * The guard and the report must agree. A guard that blocks something the report
 * calls fine (or lets through something the report calls Broken) is two tools
 * disagreeing — the exact split that made people turn the guard off. This runs a
 * command list through BOTH the guard (in a no-prompt mode) and the check path,
 * and asserts: guard DENIES iff the check would call it Broken.
 *
 * Found by three independent real-world tests (2026-09-29): the guard had its
 * own command parser and asked on feature-branch pushes and on mentions, and
 * missed `sh -c` wrapped pushes. Now both use the same parser + branch scoping.
 */
const RULES = "## 1. approval\nNever push to main without asking me first.\n";

function sessionFor(command: string): string {
  return [
    { type: "user", timestamp: "t", message: { role: "user", content: "do the work" }, permissionMode: "bypassPermissions" },
    { type: "assistant", timestamp: "t", message: { role: "assistant", content: [{ type: "tool_use", id: "a", name: "Bash", input: { command } }] } },
  ].map((l) => JSON.stringify(l)).join("\n");
}
function guardDenies(dir: string, command: string): boolean {
  return guardDecision(dir, "Bash", { command }, [], "bypassPermissions").deny;
}
function checkBroken(command: string): boolean {
  const r = checkSessionInBrowser(RULES, sessionFor(command)).results.find((x) => /approval|push/i.test(x.ruleTitle));
  return r?.status === "FAIL";
}

const CASES: { command: string; broken: boolean }[] = [
  { command: "git push origin main", broken: true },
  { command: "sh -c 'git push origin main'", broken: true },
  { command: 'bash -lc "git push origin main"', broken: true },
  { command: "git push origin feature/login", broken: false },
  { command: "echo git push is bad", broken: false },
  { command: "git status", broken: false },
];

describe("guard and check agree (parity)", () => {
  let dir: string;
  it("sets up", () => {
    dir = mkdtempSync(join(tmpdir(), "rr-parity-"));
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, "CLAUDE.md"), RULES);
    expect(dir).toBeTruthy();
  });

  for (const c of CASES) {
    it(`"${c.command}" — guard deny == check Broken == ${c.broken}`, () => {
      const denies = guardDenies(dir, c.command);
      const broken = checkBroken(c.command);
      expect(broken, `check verdict for "${c.command}"`).toBe(c.broken);
      expect(denies, `guard decision for "${c.command}"`).toBe(c.broken);
    });
  }

  it("cleans up", () => {
    rmSync(dir, { recursive: true, force: true });
    expect(true).toBe(true);
  });
});
