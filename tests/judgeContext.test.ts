import { describe, it, expect } from "vitest";
import { ruleKeywords, readableLine, extractExcerpt } from "../src/judgeContext.js";

describe("judge context: keywords", () => {
  it("pulls distinctive keys (quoted strings, dotfiles, flags) and drops stopwords", () => {
    const keys = ruleKeywords('Never commit the ".env" file or run `git push origin main`');
    expect(keys).toContain(".env");
    expect(keys).toContain("git push origin main");
    // common words are dropped
    expect(keys).not.toContain("the");
    expect(keys).not.toContain("never");
  });
});

describe("judge context: readable projection of a transcript line", () => {
  it("extracts said/done text from a JSON line, skips ids/scaffolding", () => {
    const line = JSON.stringify({
      messageId: "90954fd1fcfc4cf596",
      timestamp: "2026-10-09T06:05:24.078Z",
      message: { role: "assistant", content: [{ type: "text", text: "I will run git push origin main now" }] },
    });
    const r = readableLine(line);
    expect(r).toContain("git push origin main");
    expect(r).not.toContain("90954fd1"); // the id is scaffolding
    expect(r).not.toContain("messageId");
  });

  it("returns a non-JSON line unchanged", () => {
    expect(readableLine("plain log: did a thing")).toBe("plain log: did a thing");
  });
});

describe("judge context: bounded excerpt", () => {
  // Real Claude Code transcript shape: typed user/assistant events.
  const asst = (t: string) => JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: t }] } });
  const user = (t: string) => JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: t }] } });
  const transcript = [
    asst("setting up the project"),
    asst("running the tool: git push origin main to deploy"),
    asst("unrelated chatter about lunch"),
  ].join("\n");

  it("finds the keyword line, from readable content not JSON, with the path and a match count", () => {
    const ctx = extractExcerpt("Never push to main", transcript, "/tmp/session.jsonl");
    expect(ctx.transcriptPath).toBe("/tmp/session.jsonl");
    expect(ctx.excerpt).toContain("git push origin main");
    expect(ctx.excerpt).not.toContain("messageId");
    expect(ctx.matchCount).toBeGreaterThanOrEqual(1);
  });

  it("is bounded — a pathological session cannot produce a giant excerpt", () => {
    const huge = Array.from({ length: 5000 }, () => asst("push to main happened here")).join("\n");
    const ctx = extractExcerpt("push to main", huge, null, "", { maxChars: 800, maxLines: 10 });
    expect(ctx.excerpt.length).toBeLessThanOrEqual(900);
    expect(ctx.excerpt.split("\n").length).toBeLessThanOrEqual(11);
  });

  it("empty transcript or no keywords -> empty excerpt, no throw", () => {
    expect(extractExcerpt("think carefully", "", null).excerpt).toBe("");
    expect(extractExcerpt("", "some text", null).excerpt).toBe("");
  });

  // RED-FIRST (added 2026-11-27, Shilpa): the excerpt must be built from what was
  // actually said/done, NOT from harness-injected scaffolding. A session whose
  // first user turn carries the whole CLAUDE.md + environment + skill listing
  // inside <system-reminder> must not leak that boilerplate into the excerpt —
  // otherwise the judge "sees" the rule text echoed back and judges noise.
  it("skips system-reminders, environment and setup boilerplate; keeps real actions", () => {
    const boilerplate =
      "<system-reminder>\n# Environment\nYou have been invoked in the following environment: Primary working directory: /repo\n" +
      "Contents of CLAUDE.md (project instructions): Never push to main without asking first. Always run the tests.\n" +
      "The following skills are available for use with the Skill tool: deploy, audit, check.\n</system-reminder>";
    const transcript2 = [
      user(boilerplate + "\nplease fix the failing build"),
      asst("Looking at the build now"),
      asst("I ran: git push origin main to ship the fix"),
    ].join("\n");
    const ctx = extractExcerpt("Never push to main without asking first", transcript2, "/tmp/s.jsonl");
    // the real action is present...
    expect(ctx.excerpt).toContain("git push origin main");
    // ...and none of the injected scaffolding is:
    expect(ctx.excerpt).not.toContain("system-reminder");
    expect(ctx.excerpt).not.toContain("You have been invoked");
    expect(ctx.excerpt).not.toContain("available for use with the Skill tool");
    expect(ctx.excerpt).not.toContain("# Environment");
  });
});
