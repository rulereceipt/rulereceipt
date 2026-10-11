import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateSession } from "../src/evaluate.js";
import type { Rule, TranscriptEvent, CheckResult } from "../src/types.js";

/**
 * Metamorphic tests (correctness-program): transformations that MUST NOT change
 * any verdict. These catch a whole class of regressions that example-based tests
 * miss — a checker that quietly keys off event order, rule order, surrounding
 * whitespace, or an unrelated path would pass its own unit test and still be
 * wrong. Each transform is a known invariant; the verdict set must survive it.
 */
function bash(command: string): TranscriptEvent {
  return { role: "assistant", kind: "tool_use", toolName: "Bash", input: { command }, timestamp: "2026-10-11T00:00:00Z" };
}
function text(role: "user" | "assistant", t: string): TranscriptEvent {
  return { role, kind: "text", text: t, timestamp: "2026-10-11T00:00:00Z" };
}
const llmStub = (rule: Rule): CheckResult => ({ ruleId: rule.id, ruleTitle: rule.title, ruleSource: rule.source, status: "UNCLEAR", evidence: "llm-stub" });

const RULES: Rule[] = [
  { id: "1", title: "No direct push to main", text: "Never push to the `main` branch.", source: "project" },
  { id: "2", title: "No touching the demo branch", text: "Never touch the `demo` branch.", source: "project" },
];
const EVENTS: TranscriptEvent[] = [
  text("user", "please sync and push the release"),
  bash("git fetch origin"),
  bash("git push origin main"),
];

let cwd: string;
beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), "rr-metamorphic-")); });
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

async function verdicts(rules: Rule[], events: TranscriptEvent[]): Promise<Record<string, string>> {
  const { results } = await evaluateSession(cwd, rules, events, false, llmStub);
  const m: Record<string, string> = {};
  for (const r of results) m[r.ruleId] = r.status;
  return m;
}

describe("metamorphic invariants: these transforms must not change any verdict", () => {
  it("baseline: push-to-main FAILs, demo rule does not", async () => {
    const v = await verdicts(RULES, EVENTS);
    expect(v["1"]).toBe("FAIL");
    expect(v["2"]).toBe("UNCLEAR"); // never touched the demo branch
  });

  it("adding UNRELATED events does not change verdicts", async () => {
    const base = await verdicts(RULES, EVENTS);
    const noisy = [text("assistant", "Let me check the status first."), bash("ls -la"), ...EVENTS, bash("echo done"), text("assistant", "All set.")];
    expect(await verdicts(RULES, noisy)).toEqual(base);
  });

  it("reordering INDEPENDENT rules does not change verdicts", async () => {
    const base = await verdicts(RULES, EVENTS);
    expect(await verdicts([...RULES].reverse(), EVENTS)).toEqual(base);
  });

  it("whitespace changes in rule text do not change verdicts", async () => {
    const base = await verdicts(RULES, EVENTS);
    const spaced = RULES.map((r) => ({ ...r, text: `   ${r.text.replace(/ /g, "  ")}   \n` }));
    expect(await verdicts(spaced, EVENTS)).toEqual(base);
  });

  it("renaming a path NOT mentioned by any rule does not change verdicts", async () => {
    const base = await verdicts(RULES, EVENTS);
    const renamed = EVENTS.map((e) =>
      e.kind === "tool_use" && typeof (e.input as { command?: string }).command === "string"
        ? { ...e, input: { command: (e.input as { command: string }).command.replace("origin", "upstream-origin") } }
        : e
    ) as TranscriptEvent[];
    // `git push upstream-origin main` still targets main → still FAIL; the remote
    // rename is an unmentioned path and must not perturb the demo rule either.
    expect(await verdicts(RULES, renamed)).toEqual(base);
  });
});
