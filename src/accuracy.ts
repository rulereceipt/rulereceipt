import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CheckResult, Rule, TranscriptEvent } from "./types.js";
import { evaluateSession } from "./evaluate.js";
import { redact } from "./wrong.js";
import { ruleFingerprint } from "./overrides.js";

/**
 * Every wrong verdict a user reports is the most valuable test case we can get:
 * a real rule + a real session on which a check got it wrong. `wrong --save`
 * keeps a REDACTED copy as a permanent local fixture under .rulereceipt/fixtures/,
 * and `accuracy` re-runs each one through the CURRENT engine — so a case we've
 * since fixed shows as resolved, and one we haven't shows as still-wrong, per
 * check. This is the same discipline as the frozen fa-corpus, sourced from the
 * field instead of invented by us. Fixtures are local only; nothing is sent.
 */

export const FIXTURE_DIR = join(".rulereceipt", "fixtures");

/** "not-fail" = a false accusation (reported FAIL, should not have); "fail" = a miss (should have FAILed). */
export type Expected = "not-fail" | "fail";

export interface Fixture {
  handle: string;
  savedAt: string;
  version: string;
  rule: { id: string; title: string; text: string; source: Rule["source"]; paths?: string[] };
  events: TranscriptEvent[];
  reportedStatus: CheckResult["status"];
  reportedMethod: CheckResult["method"] | "unknown";
  expected: Expected;
}

function redactEvent(e: TranscriptEvent, home: string): TranscriptEvent {
  const r = (s: string) => redact(s, home);
  if (e.kind === "text") return { ...e, text: r(e.text) };
  if (e.kind === "tool_use") {
    const input = { ...(e.input as Record<string, unknown>) };
    for (const k of ["command", "content", "new_string", "new_source", "file_path", "old_string"]) {
      if (typeof input[k] === "string") input[k] = r(input[k] as string);
    }
    return { ...e, input };
  }
  if (e.kind === "tool_result") {
    const c = (e as { content?: unknown }).content;
    return typeof c === "string" ? ({ ...e, content: r(c) } as TranscriptEvent) : e;
  }
  return e;
}

export interface SaveFixtureInput {
  cwd: string;
  version: string;
  rule: Rule;
  result: CheckResult;
  events: TranscriptEvent[];
  home?: string;
}

/** Writes a redacted fixture; returns the path written. */
export function saveFixture(input: SaveFixtureInput): string {
  const home = input.home ?? homedir();
  const handle = ruleFingerprint(input.rule);
  const expected: Expected = input.result.status === "FAIL" ? "not-fail" : "fail";
  const fixture: Fixture = {
    handle,
    savedAt: new Date().toISOString(),
    version: input.version,
    rule: {
      id: input.rule.id,
      title: redact(input.rule.title, home),
      text: redact(input.rule.text ?? "", home),
      source: input.rule.source,
      ...(input.rule.paths ? { paths: input.rule.paths } : {}),
    },
    events: input.events.map((e) => redactEvent(e, home)),
    reportedStatus: input.result.status,
    reportedMethod: input.result.method ?? "unknown",
    expected,
  };
  const dir = join(input.cwd, FIXTURE_DIR);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${handle}.json`);
  writeFileSync(file, JSON.stringify(fixture, null, 2) + "\n");
  return file;
}

export function loadFixtures(cwd: string): Fixture[] {
  const dir = join(cwd, FIXTURE_DIR);
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const out: Fixture[] = [];
  for (const n of names) {
    try {
      out.push(JSON.parse(readFileSync(join(dir, n), "utf-8")) as Fixture);
    } catch {
      /* skip a corrupt fixture rather than crash the whole report */
    }
  }
  return out;
}

export interface MethodAccuracy {
  method: string;
  total: number;
  resolved: number;
  stillWrong: number;
}
export interface AccuracyReport {
  total: number;
  resolved: number;
  stillWrong: number;
  byMethod: MethodAccuracy[];
  stillWrongHandles: string[];
}

function ruleOf(f: Fixture): Rule {
  return { id: f.rule.id, title: f.rule.title, text: f.rule.text, source: f.rule.source, ...(f.rule.paths ? { paths: f.rule.paths } : {}) } as Rule;
}

/**
 * Re-runs each fixture through the current engine and reports, per check, how
 * many we've since fixed vs still get wrong. A neutral cwd is used so the
 * project's own overrides/git-age don't change the fixture's outcome.
 */
export async function replayFixtures(cwd: string): Promise<AccuracyReport> {
  const fixtures = loadFixtures(cwd);
  const neutralCwd = join(cwd, FIXTURE_DIR); // no .claude / no git here: overrides empty, age fails open
  const byMethod = new Map<string, MethodAccuracy>();
  const stillWrongHandles: string[] = [];
  let resolved = 0;
  let stillWrong = 0;

  for (const f of fixtures) {
    const evalResult = await evaluateSession(neutralCwd, [ruleOf(f)], f.events, false, (rule) => ({
      ruleId: rule.id,
      ruleTitle: rule.title,
      ruleSource: rule.source,
      status: "UNCLEAR" as const,
      evidence: "llm not run during fixture replay",
    }));
    const current = evalResult.results.find((r) => r.ruleId === f.rule.id);
    const currentFails = current?.status === "FAIL";
    const isStillWrong = f.expected === "not-fail" ? currentFails : !currentFails;
    if (isStillWrong) {
      stillWrong++;
      stillWrongHandles.push(f.handle);
    } else {
      resolved++;
    }
    const key = f.reportedMethod ?? "unknown";
    const m = byMethod.get(key) ?? { method: key, total: 0, resolved: 0, stillWrong: 0 };
    m.total++;
    if (isStillWrong) m.stillWrong++;
    else m.resolved++;
    byMethod.set(key, m);
  }

  return {
    total: fixtures.length,
    resolved,
    stillWrong,
    byMethod: [...byMethod.values()].sort((a, b) => b.total - a.total),
    stillWrongHandles,
  };
}

export function renderAccuracy(r: AccuracyReport): string {
  const out: string[] = [];
  if (r.total === 0) {
    out.push("No saved fixtures yet. When a verdict is wrong, run:  rulereceipt wrong <handle> --save");
    out.push("Each saved case becomes a permanent, redacted regression test, replayed here.");
    return out.join("\n");
  }
  out.push(`Per-check accuracy on ${r.total} reported-wrong case${r.total === 1 ? "" : "s"} (replayed through the current build):`);
  out.push(`  resolved (now correct): ${r.resolved}`);
  out.push(`  still wrong:            ${r.stillWrong}`);
  out.push("");
  out.push("By check:");
  for (const m of r.byMethod) {
    out.push(`  • ${String(m.method).padEnd(18)} ${m.resolved}/${m.total} resolved${m.stillWrong ? `  (${m.stillWrong} still wrong)` : ""}`);
  }
  if (r.stillWrongHandles.length > 0) {
    out.push("");
    out.push(`Still wrong — open regressions to fix: ${r.stillWrongHandles.join(", ")}`);
  }
  return out.join("\n");
}
