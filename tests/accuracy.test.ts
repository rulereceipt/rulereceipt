import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveFixture, loadFixtures, replayFixtures, FIXTURE_DIR } from "../src/accuracy.js";
import type { CheckResult, Rule, TranscriptEvent } from "../src/types.js";

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "rr-acc-"));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

const rule = (title: string): Rule => ({ id: "r1", title, text: "", source: "project" }) as Rule;
const result = (status: CheckResult["status"], method: CheckResult["method"]): CheckResult => ({ ruleId: "r1", ruleTitle: "x", ruleSource: "project", status, method, evidence: "e" });
const bash = (command: string): TranscriptEvent => ({ role: "assistant", kind: "tool_use", toolName: "Bash", input: { command }, timestamp: "t" });
const write = (content: string): TranscriptEvent => ({ role: "assistant", kind: "tool_use", toolName: "Write", input: { file_path: "src/x.ts", content }, timestamp: "t" });

describe("wrong --save fixtures + accuracy replay", () => {
  it("saves a redacted fixture and loads it back", () => {
    const home = cwd; // make the home path appear in content so redaction has something to mask
    saveFixture({ cwd, version: "0.1.90", rule: rule("No console"), result: result("FAIL", "code_content"), events: [write(`// path ${home}/secret\nconst x=1;`)], home });
    const loaded = loadFixtures(cwd);
    expect(loaded.length).toBe(1);
    expect(loaded[0].expected).toBe("not-fail"); // reported FAIL => false accusation
    const raw = readFileSync(join(cwd, FIXTURE_DIR, `${loaded[0].handle}.json`), "utf-8");
    expect(raw).not.toContain(`${home}/secret`); // home path was redacted
  });

  it("marks a since-FIXED false accusation as resolved (codeContent comment mention)", async () => {
    saveFixture({
      cwd, version: "0.1.90",
      rule: rule("Never leave a `console.log(` call in committed code."),
      result: result("FAIL", "code_content"), // the user reported this FAIL as wrong
      events: [write("// never use console.log( here\nexport const x = 1;\n")],
    });
    const r = await replayFixtures(cwd);
    expect(r.total).toBe(1);
    expect(r.resolved).toBe(1); // current build no longer FAILs on a comment mention
    expect(r.stillWrong).toBe(0);
  });

  it("keeps a genuinely-correct FAIL as still-wrong when reported as a false accusation", async () => {
    saveFixture({
      cwd, version: "0.1.90",
      rule: rule("Never push to the `main` branch directly."),
      result: result("FAIL", "git_events"),
      events: [bash("git push origin main")],
    });
    const r = await replayFixtures(cwd);
    expect(r.stillWrong).toBe(1); // behaviour unchanged: the push to main still FAILs, honestly
    expect(r.byMethod[0].method).toBe("git_events");
  });

  it("reports nothing when there are no fixtures", async () => {
    const r = await replayFixtures(cwd);
    expect(r.total).toBe(0);
  });
});
