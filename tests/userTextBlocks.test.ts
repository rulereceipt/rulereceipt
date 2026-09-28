import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTranscriptFromFile } from "../src/parsers/transcriptParser.js";

function file(lines: unknown[]): string {
  const p = join(mkdtempSync(join(tmpdir(), "rr-ut-")), "s.jsonl");
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n"));
  return p;
}

describe("user messages sent as content blocks", () => {
  it("reads text blocks and strips harness-injected tags", () => {
    const events = readTranscriptFromFile(file([
      { type: "user", timestamp: "t", message: { role: "user", content: [
        { type: "text", text: "<ide_opened_file>The user opened a.ts</ide_opened_file>" },
        { type: "text", text: "yes, go ahead and push" },
      ] } },
    ]));
    const texts = events.filter((e) => e.kind === "text" && e.role === "user").map((e) => (e as { text: string }).text);
    expect(texts).toEqual(["yes, go ahead and push"]);
  });
  it("still reads plain string content and tool results", () => {
    const events = readTranscriptFromFile(file([
      { type: "user", timestamp: "t", message: { role: "user", content: "hello" } },
      { type: "user", timestamp: "t", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }] } },
    ]));
    expect(events.map((e) => e.kind)).toEqual(["text", "tool_result"]);
  });
});
