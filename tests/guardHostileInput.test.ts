import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardDecision } from "../src/guard.js";

/**
 * Pen-test (2026-10-22): hostile input to the pre-action guard.
 *
 * The guard reads a PROPOSED Bash command as DATA to decide allow/block — it
 * never executes it (the only child process it spawns is `git symbolic-ref`
 * with fixed args). Two properties must hold against adversarial commands:
 *   1. It never throws and never stalls — a malformed / huge / exotic command
 *      must return a decision in bounded time (fails safe, never crashes `check`).
 *   2. Its recall limits are DOCUMENTED, not silent: command-substitution,
 *      backticks and unicode look-alikes are not decoded (same class as the
 *      base64|sh / xargs gaps already pinned in guardBypass). Pinned so the
 *      suite stays honest; if a future change starts catching one, flip it.
 */
describe("guard is robust to hostile command input", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "rr-guard-hostile-"));
    writeFileSync(join(dir, "CLAUDE.md"), "## Branch\nNever push to the `main` branch directly.\n");
  });
  const decide = (command: string) => guardDecision(dir, "Bash", { command }, [], "bypassPermissions");

  const hostile: [string, string][] = [
    ["null byte", "git push\u0000origin main"],
    ["embedded newlines", "git\npush\norigin\nmain"],
    ["rtl override", "git push origin ‮main"],
    ["zero-width joiners", "git​push​origin​main"],
    ["half-megabyte arg", "git push origin " + "a".repeat(500_000) + " main"],
    ["200k separators", ";".repeat(200_000) + "git push origin main"],
    ["nested substitution", "$(`$(git push origin main)`)"],
  ];
  for (const [name, command] of hostile) {
    it(`returns a decision without throwing or stalling: ${name}`, () => {
      const t0 = performance.now();
      const d = decide(command);
      const dt = performance.now() - t0;
      expect(typeof d.deny).toBe("boolean");
      expect(dt).toBeLessThan(1000);
    });
  }
});

describe("guard recall limits (documented, not silently passed)", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "rr-guard-limits-"));
    writeFileSync(join(dir, "CLAUDE.md"), "## Branch\nNever push to the `main` branch directly.\n");
  });
  const deny = (command: string) => guardDecision(dir, "Bash", { command }, [], "bypassPermissions").deny;

  // The guard can read `sh -c "..."`, `eval "..."`, `&&` and `;` chains (see
  // guardBypass), but it does NOT decode command substitution, backticks, or
  // unicode homoglyphs of a branch name. These are pinned as current misses.
  it("misses a push inside $(...) command substitution", () => {
    expect(deny("echo $(git push origin main)")).toBe(false);
  });
  it("misses a push inside backticks", () => {
    expect(deny("echo `git push origin main`")).toBe(false);
  });
  it("misses a cyrillic-homoglyph branch name (mаin)", () => {
    expect(deny("git push origin mаin")).toBe(false);
  });
});
