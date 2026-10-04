import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { replayGuard } from "../src/replay.js";

/**
 * Shadow replay: the current guard + rules, run against a past session on disk,
 * must report what it WOULD have blocked — and must respect a prior approval in
 * the same session, exactly as the live guard would. Writes a real transcript
 * under the Claude Code project dir for the temp cwd.
 */
let dir: string;
let projectDir: string;

function writeSession(name: string, events: object[]) {
  const slug = dir.replace(/[/.]/g, "-");
  projectDir = join(homedir(), ".claude", "projects", slug);
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, name), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
}
const bash = (command: string, i: number) => ({
  type: "assistant",
  timestamp: `2026-10-04T00:00:0${i}Z`,
  message: { role: "assistant", content: [{ type: "tool_use", id: `t${i}`, name: "Bash", input: { command } }] },
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rr-replay-"));
  writeFileSync(join(dir, "CLAUDE.md"), "## Branch\nNever push to the `main` branch directly.\n");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (projectDir) rmSync(projectDir, { recursive: true, force: true });
});

describe("protect --replay (shadow)", () => {
  it("reports a push-to-main that would have been blocked", () => {
    writeSession("s1.jsonl", [bash("git push origin main", 0)]);
    const r = replayGuard(dir);
    expect(r.sessions).toBe(1);
    expect(r.calls).toBe(1);
    expect(r.wouldDeny).toBe(1);
    expect(r.byRule.some((row) => row.deny === 1)).toBe(true);
  });

  it("does not count a safe command", () => {
    writeSession("s2.jsonl", [bash("git push origin feature/x", 0), bash("npm test", 1)]);
    const r = replayGuard(dir);
    expect(r.calls).toBe(2);
    expect(r.wouldDeny).toBe(0);
  });

  it("changes nothing on disk (no settings written)", () => {
    writeSession("s3.jsonl", [bash("git push origin main", 0)]);
    replayGuard(dir);
    // the guard-replay must not create .claude/settings.json
    expect(existsSync(join(dir, ".claude", "settings.json"))).toBe(false);
  });
});
