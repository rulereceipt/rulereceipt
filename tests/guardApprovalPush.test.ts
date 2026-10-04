import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardDecision } from "../src/guard.js";
import type { TranscriptEvent } from "../src/types.js";

/**
 * Regression lock (2026-10-03): when a gated push is EXPLICITLY approved in the
 * transcript ("go, push"), the guard must not block it. A guard that blocks an
 * approved action is a false-block — the live-blocking equivalent of a false
 * accusation — so this pins the correct behaviour in every permission mode.
 *
 * The no-approval cases assert the opposite direction, so the test discriminates
 * real approval handling from a rule that simply never fires: if approval
 * detection regressed, the "approved" cases flip to ask/deny and fail here.
 */
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rr-guard-approve-"));
  writeFileSync(join(dir, "CLAUDE.md"), "## 1. Push\nNever push without the user's explicit approval.\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const t = (role: "assistant" | "user", text: string): TranscriptEvent => ({ role, kind: "text", text, timestamp: "t" });
const approved: TranscriptEvent[] = [t("assistant", "I am about to push to the remote. OK to push?"), t("user", "go, push")];
const noApproval: TranscriptEvent[] = [t("assistant", "Working on it.")];
const PUSH = "git push origin somewhere"; // a push that is NOT an absolute-banned branch

describe("guard honours an explicit in-transcript approval of a gated push", () => {
  it("does NOT block an approved push in default mode", () => {
    const d = guardDecision(dir, "Bash", { command: PUSH }, approved, "default");
    expect(d.deny).toBe(false);
    expect(d.ask).toBeFalsy();
  });

  it("does NOT block an approved push even in bypassPermissions mode", () => {
    const d = guardDecision(dir, "Bash", { command: PUSH }, approved, "bypassPermissions");
    expect(d.deny).toBe(false);
    expect(d.ask).toBeFalsy();
  });

  // The discriminating direction: with no approval, the gate must still engage.
  it("asks when a gated push has no approval (default mode shows a prompt)", () => {
    const d = guardDecision(dir, "Bash", { command: PUSH }, noApproval, "default");
    expect(d.deny).toBe(false);
    expect(d.ask).toBeTruthy();
  });

  it("denies an unapproved gated push in a no-prompt mode", () => {
    const d = guardDecision(dir, "Bash", { command: PUSH }, noApproval, "bypassPermissions");
    expect(d.deny).toBe(true);
  });
});
