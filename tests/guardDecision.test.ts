import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { guardDecision } from "../src/guard.js";

/**
 * guardDecision is the pure allow/deny seam behind the shell hook — the
 * function a future in-process host (a function hook, once that Anthropic
 * proposal ships) would call without re-deriving the logic. Tested directly,
 * with no stdin/stdout, and with HOME isolated so the real global CLAUDE.md
 * never leaks in.
 */
const homeState = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  homeState.current = actual.homedir();
  return { ...actual, homedir: () => homeState.current };
});

let home: string;
let project: string;
const realHome = homeState.current;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "rr-gd-home-"));
  project = mkdtempSync(join(tmpdir(), "rr-gd-proj-"));
  homeState.current = home;
  mkdirSync(join(project, ".git"));
  writeFileSync(
    join(project, "CLAUDE.md"),
    "# Rules\n\n## 1. Never delete the ledger\nNever delete `data/ledger.db`. Do not run `rm` on `data/ledger.db`.\n"
  );
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
  homeState.current = realHome;
});

describe("guardDecision", () => {
  it("denies a command that breaks a file rule, with a reason", () => {
    const d = guardDecision(project, "Bash", { command: "rm data/ledger.db" });
    expect(d.deny).toBe(true);
    expect(d.reason).toContain("Never delete the ledger");
    expect(d.blocks.length).toBeGreaterThan(0);
  });

  it("allows an unrelated command", () => {
    expect(guardDecision(project, "Bash", { command: "git status" }).deny).toBe(false);
  });

  it("allows a tool it does not inspect", () => {
    expect(guardDecision(project, "Read", { file_path: "data/ledger.db" }).deny).toBe(false);
  });

  it("fails open when the project has no rules", () => {
    const empty = mkdtempSync(join(tmpdir(), "rr-gd-empty-"));
    mkdirSync(join(empty, ".git"));
    try {
      expect(guardDecision(empty, "Bash", { command: "rm data/ledger.db" }).deny).toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
