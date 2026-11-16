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
  const transcript = [
    JSON.stringify({ id: "aaaa1111bbbb2222", message: { content: [{ text: "setting up the project" }] } }),
    JSON.stringify({ message: { content: [{ text: "running the tool: git push origin main to deploy" }] } }),
    JSON.stringify({ message: { content: [{ text: "unrelated chatter about lunch" }] } }),
  ].join("\n");

  it("finds the keyword line, from readable content not JSON, with the path and a match count", () => {
    const ctx = extractExcerpt("Never push to main", transcript, "/tmp/session.jsonl");
    expect(ctx.transcriptPath).toBe("/tmp/session.jsonl");
    expect(ctx.excerpt).toContain("git push origin main");
    expect(ctx.excerpt).not.toContain("messageId");
    expect(ctx.matchCount).toBeGreaterThanOrEqual(1);
  });

  it("is bounded — a pathological session cannot produce a giant excerpt", () => {
    const huge = Array.from({ length: 5000 }, () => JSON.stringify({ message: { content: [{ text: "push to main happened here" }] } })).join("\n");
    const ctx = extractExcerpt("push to main", huge, null, "", { maxChars: 800, maxLines: 10 });
    expect(ctx.excerpt.length).toBeLessThanOrEqual(900);
    expect(ctx.excerpt.split("\n").length).toBeLessThanOrEqual(11);
  });

  it("empty transcript or no keywords -> empty excerpt, no throw", () => {
    expect(extractExcerpt("think carefully", "", null).excerpt).toBe("");
    expect(extractExcerpt("", "some text", null).excerpt).toBe("");
  });
});
