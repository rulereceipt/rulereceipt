import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { redact, buildWrongReport, findTarget, reportedLabel, excerptAround, minimalIssueUrl } from "../src/wrong.js";
import { ruleFingerprint } from "../src/overrides.js";
import { generateHtmlReport } from "../src/report/generateHtmlReport.js";
import type { CheckResult, Rule, TranscriptEvent } from "../src/types.js";

const rule = (id: string, title: string): Rule => ({ id, title, text: title, source: "project" });
const res = (r: Rule, status: CheckResult["status"], evidence: string, extra: Partial<CheckResult> = {}): CheckResult =>
  ({ ruleId: r.id, ruleTitle: r.title, ruleSource: r.source, status, evidence, ...extra });
const bash = (command: string): TranscriptEvent => ({ role: "assistant", kind: "tool_use", toolName: "Bash", input: { command }, timestamp: "t" });
const user = (text: string): TranscriptEvent => ({ role: "user", kind: "text", text, timestamp: "t" });

describe("redact", () => {
  it("masks common secrets, emails and the home path", () => {
    const out = redact("key sk-abcdefghijklmnop1234 token ghp_abcdefghijklmnopqrstuv mail a.b@corp.com at /home/dev/app password=hunter22x", "/home/dev");
    expect(out).not.toMatch(/sk-abcdef|ghp_abc|a\.b@corp|\/home\/dev|hunter22x/);
    expect(out).toContain("~/app");
  });

  it("masks provider tokens with distinctive prefixes (gitleaks/secretlint formats)", () => {
    const cases: [string, RegExp][] = [
      [("AIza"+"SyA1234567890123456789012345678901234"), /AIzaSy/],
      [("ya29."+"a0AfH6SMByExampleToken1234567890"), /ya29\.a0/],
      [("glpat-"+"ABCDEFghij1234567890"), /glpat-ABC/],
      [("npm_"+"abcdefghijklmnopqrstuvwxyz0123456789"), /npm_abcd/],
      [("SG."+"abcdefghijklmnopqrstuv.abcdefghijklmnopqrstuvwxyz0123456789012"), /SG\.abcdef/],
      [("https://hooks.slack.com/services/"+"T00000000/B00000000/XXXXXXXXXXXXXXXXXXXXXXXX"), /hooks\.slack\.com\/services\/T0/],
      [("https://discord.com/api/webhooks/"+"123456789012345678/abcDEF_ghi-jkl"), /discord\.com\/api\/webhooks\/1234/],
    ];
    for (const [secret, leak] of cases) {
      const out = redact(`here it is: ${secret} end`);
      expect(out, `should mask: ${secret}`).not.toMatch(leak);
      expect(out).toContain("<redacted");
    }
  });

  it("does not mask ordinary text", () => {
    const out = redact("git push origin feature/login && npm test -- --run");
    expect(out).toBe("git push origin feature/login && npm test -- --run");
  });
});

describe("reportedLabel matches the issue template options", () => {
  const r = rule("1", "x");
  it("maps every verdict", () => {
    expect(reportedLabel(res(r, "FAIL", ""))).toBe("Not followed");
    expect(reportedLabel(res(r, "PASS", ""))).toBe("Followed");
    expect(reportedLabel(res(r, "UNCLEAR", "", { needsHuman: true }))).toBe("Needs your judgment");
    expect(reportedLabel(res(r, "UNCLEAR", ""))).toBe("Couldn't tell");
    const tpl = readFileSync(join(process.cwd(), ".github", "ISSUE_TEMPLATE", "wrong-result.yml"), "utf-8");
    for (const o of ["Not followed", "Followed", "Needs your judgment", "Couldn't tell"]) expect(tpl).toContain(o);
  });
});

describe("buildWrongReport", () => {
  const r = rule("S1.1", "Never push without explicit user instruction.");
  const events = [user("fix the page"), bash("npm test"), bash("git push origin main"), user("why did you push?")];
  const result = res(r, "FAIL", 'ran "git push origin main" with no approval: nothing in the chat approved it', { method: "approval_gate" });
  const rep = buildWrongReport({ version: "9.9.9", rule: r, result, events, home: "/nonexistent" });
  it("contains the rule, verdict, method, handle and nearby session lines", () => {
    expect(rep.handle).toBe(ruleFingerprint(r));
    expect(rep.markdown).toContain("Never push without explicit user instruction.");
    expect(rep.markdown).toContain("What RuleReceipt reported: Not followed");
    expect(rep.markdown).toContain("method: approval_gate");
    expect(rep.markdown).toContain("assistant ran Bash: git push origin main");
    expect(rep.markdown).toContain("user: fix the page");
  });
  it("builds a pre-filled issue link for the wrong-result template", () => {
    const u = new URL(rep.issueUrl);
    expect(u.searchParams.get("template")).toBe("wrong-result.yml");
    expect(u.searchParams.get("reported")).toBe("Not followed");
    expect(u.searchParams.get("version")).toBe("9.9.9");
    expect(u.searchParams.get("rule")).toContain("Never push");
  });
  it("adds no excerpt when the evidence matches nothing, instead of guessing", () => {
    expect(excerptAround(events, "no occurrence of anything")).toEqual([]);
  });
  it("keeps the link short enough for a browser", () => {
    const big = rule("S2", "x".repeat(20000));
    const long = buildWrongReport({ version: "1", rule: big, result: res(big, "FAIL", "y".repeat(20000)), events: [] });
    expect(long.issueUrl.length).toBeLessThan(8200);
  });
});

describe("findTarget", () => {
  const a = { ...rule("S1.1", "Never push without asking."), source: "project" as const };
  const b = { ...rule("S1.1", "Never edit .env"), source: "project" as const };
  const results = [res(a, "FAIL", "x"), res(b, "PASS", "y")];
  it("finds by handle, and by id only when unique", () => {
    expect((findTarget(ruleFingerprint(a), [a, b], results) as { rule: Rule }).rule.title).toBe(a.title);
    expect(findTarget(ruleFingerprint(b).slice(0, 8), [a, b], results)).toHaveProperty("rule");
    expect(findTarget("S1.1", [a, b], results)).toHaveProperty("ambiguous");
    expect(findTarget("nope", [a, b], results)).toBeNull();
  });
});

describe("HTML report link carries no rule text or evidence", () => {
  it("links decided verdicts with version and verdict only", () => {
    const r = rule("1", "Never touch secret-project-name");
    const html = generateHtmlReport([res(r, "FAIL", "edited secret-project-name/config")], { sessionFilePath: "s", ruleCount: 1, projectPath: "/p", generatedAt: new Date(0), toolVersion: "1.2.3" });
    const link = html.match(/href="([^"]*issues\/new[^"]*)"/)?.[1] ?? "";
    expect(link).toContain("template=wrong-result.yml");
    expect(link).not.toContain("secret-project-name");
    expect(minimalIssueUrl(res(r, "FAIL", "z"), "1.2.3")).not.toContain("secret");
  });
});

describe("rulereceipt wrong (CLI)", () => {
  const dir = mkdtempSync(join(tmpdir(), "rr-wrong-"));
  mkdirSync(join(dir, ".git"));
  writeFileSync(join(dir, "CLAUDE.md"), "- Never push without explicit user instruction.\n- Keep changes small.\n");
  const line = (o: unknown) => JSON.stringify(o);
  const s = join(dir, "s.jsonl");
  writeFileSync(s, [
    line({ type: "user", timestamp: "2026-09-28T00:00:00Z", permissionMode: "bypassPermissions", message: { role: "user", content: "fix it, token=abcdef123456" } }),
    line({ type: "assistant", timestamp: "2026-09-28T00:00:01Z", message: { role: "assistant", content: [{ type: "tool_use", id: "a", name: "Bash", input: { command: "git push origin main" } }] } }),
    line({ type: "user", timestamp: "2026-09-28T00:00:02Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "ok" }] } }),
  ].join("\n"));
  const env = { ...process.env, HOME: mkdtempSync(join(tmpdir(), "rr-home-")) };
  const cli = (...args: string[]) => execFileSync("node", [join(process.cwd(), "dist", "cli.js"), ...args], { cwd: dir, env, encoding: "utf-8" });
  const handle = ruleFingerprint({ id: "x", title: "Never push without explicit user instruction.", text: "Never push without explicit user instruction.", source: "project" });

  it("check points to it after a decided verdict", () => {
    expect(cli("check", "--transcript", s, "--exit-zero")).toContain("rulereceipt wrong");
  });
  it("writes a local report, masks secrets, prints the link, sends nothing", () => {
    const out = cli("wrong", handle, "--transcript", s);
    expect(out).toContain("Nothing was sent");
    expect(out).toContain("https://github.com/rulereceipt/rulereceipt/issues/new?");
    const saved = readFileSync(join(dir, ".rulereceipt", `wrong-${handle}.md`), "utf-8");
    expect(saved).toContain("Not followed");
    expect(saved).not.toContain("abcdef123456");
  });
  it("fails clearly on an unknown rule", () => {
    expect(() => cli("wrong", "nothing-like-this", "--transcript", s)).toThrow();
    expect(existsSync(join(dir, ".rulereceipt", "wrong-nothing-like-this.md"))).toBe(false);
  });
});

describe("excerpt matches across line breaks", () => {
  it("finds a multi-line command quoted on one line", () => {
    const ev = [user("go"), bash("git commit -m 'fix\n\nbody' && git push")];
    expect(excerptAround(ev, 'ran "git commit -m \'fix body\' && git push" with no approval').length).toBeGreaterThan(0);
  });
});
