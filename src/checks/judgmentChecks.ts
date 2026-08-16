import Anthropic from "@anthropic-ai/sdk";
import type { TranscriptEvent, CheckResult } from "../types.js";
import type { JudgmentClassification } from "./classify.js";

const MODEL = "claude-sonnet-4-5-20250929";
const MAX_TRANSCRIPT_CHARS = 60_000; // keeps the judgment call cheap and fast, not the whole session

function summarizeEvents(events: TranscriptEvent[]): string {
  const lines: string[] = [];
  for (const event of events) {
    if (event.kind === "text") {
      lines.push(`[${event.role}] ${event.text}`);
    } else if (event.kind === "tool_use") {
      lines.push(`[assistant used tool: ${event.toolName}] ${JSON.stringify(event.input).slice(0, 300)}`);
    } else if (event.kind === "tool_result") {
      lines.push(`[tool result${event.isError ? ", error" : ""}] ${event.content.slice(0, 300)}`);
    }
  }
  const full = lines.join("\n");
  if (full.length <= MAX_TRANSCRIPT_CHARS) return full;
  // keep the tail — the most recent part of a session is usually what a
  // rule violation like "surface bad news first" actually hinges on
  return "...[earlier session content omitted for length]...\n" + full.slice(-MAX_TRANSCRIPT_CHARS);
}

const RESULT_TOOL = {
  name: "report_results",
  description: "Report PASS/FAIL/UNCLEAR for each rule with a quoted line of evidence.",
  input_schema: {
    type: "object" as const,
    properties: {
      results: {
        type: "array" as const,
        items: {
          type: "object" as const,
          properties: {
            ruleId: { type: "string" as const },
            status: { type: "string" as const, enum: ["PASS", "FAIL", "UNCLEAR"] },
            evidence: { type: "string" as const, description: "One short quoted or paraphrased line from the session as evidence." },
          },
          required: ["ruleId", "status", "evidence"],
        },
      },
    },
    required: ["results"],
  },
};

function unclearForAll(classifications: JudgmentClassification[], reason: string): CheckResult[] {
  return classifications.map(({ rule }) => ({
    ruleId: rule.id,
    ruleTitle: rule.title,
    status: "UNCLEAR" as const,
    evidence: reason,
  }));
}

/**
 * Judgment checks need actual understanding, not pattern matching — one
 * batched API call covering every judgment rule at once, using the
 * user's OWN Anthropic API key (never ours, never proxied). Fails
 * closed: any problem (no key, API error, malformed response) reports
 * every rule as UNCLEAR with a reason — never silently marks PASS.
 */
export async function runJudgmentChecks(
  classifications: JudgmentClassification[],
  events: TranscriptEvent[]
): Promise<CheckResult[]> {
  if (classifications.length === 0) return [];

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return unclearForAll(
      classifications,
      "no ANTHROPIC_API_KEY set in your environment — set it to the same key Claude Code already uses to run judgment checks"
    );
  }

  const client = new Anthropic({ apiKey });
  const transcriptText = summarizeEvents(events);
  const rulesText = classifications
    .map(({ rule }) => `Rule ${rule.id} — ${rule.title}\n${rule.text}`)
    .join("\n\n");

  let response;
  try {
    response = await client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      tools: [RESULT_TOOL],
      tool_choice: { type: "tool", name: "report_results" },
      messages: [
        {
          role: "user",
          content: `Here are rules from a CLAUDE.md/AGENTS.md file, and a transcript of a Claude Code session. For each rule, judge whether the session's behavior actually followed it. Report PASS if clearly followed, FAIL if clearly violated, UNCLEAR if the transcript doesn't give enough to judge either way — never guess PASS when you're not sure.\n\nRULES:\n${rulesText}\n\nSESSION TRANSCRIPT:\n${transcriptText}`,
        },
      ],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return unclearForAll(classifications, `API call failed (${message}) — could not run this check`);
  }

  const toolUseBlock = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
  );
  if (!toolUseBlock) {
    return unclearForAll(classifications, "model did not return a structured result — could not run this check");
  }

  const parsed = toolUseBlock.input as { results?: Array<{ ruleId?: string; status?: string; evidence?: string }> };
  const results = parsed.results ?? [];

  return classifications.map(({ rule }) => {
    const match = results.find((r) => r.ruleId === rule.id);
    const status = match?.status;
    if (status === "PASS" || status === "FAIL" || status === "UNCLEAR") {
      return { ruleId: rule.id, ruleTitle: rule.title, status, evidence: match?.evidence ?? "" };
    }
    return {
      ruleId: rule.id,
      ruleTitle: rule.title,
      status: "UNCLEAR",
      evidence: "model response did not include a valid result for this rule",
    };
  });
}
