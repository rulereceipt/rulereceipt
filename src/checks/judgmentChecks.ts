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
  name: "report_result",
  description: "Report PASS/FAIL/UNCLEAR for this one rule with a quoted line of evidence.",
  input_schema: {
    type: "object" as const,
    properties: {
      status: { type: "string" as const, enum: ["PASS", "FAIL", "UNCLEAR"] },
      evidence: { type: "string" as const, description: "One short quoted or paraphrased line from the session as evidence." },
    },
    required: ["status", "evidence"],
  },
};

function unclear(rule: JudgmentClassification["rule"], reason: string): CheckResult {
  return { ruleId: rule.id, ruleTitle: rule.title, ruleSource: rule.source, status: "UNCLEAR", evidence: reason };
}

/**
 * One isolated API call per judgment rule, not one batched call covering
 * all of them. Deliberate, not an efficiency loss to accept: a rule
 * judged in a fresh context, with no other rules' text in the same
 * prompt, can't have its verdict colored by how the model just judged a
 * neighboring rule. Costs more calls; buys a grader that can't drift
 * across rules within a single run. Uses the user's OWN Anthropic API
 * key (never ours, never proxied). Fails closed per rule: any problem
 * (no key, API error, malformed response) reports that rule as UNCLEAR
 * — never silently marks PASS, and one rule's failure never blocks the
 * others since each call is independent.
 */
export async function runJudgmentChecks(
  classifications: JudgmentClassification[],
  events: TranscriptEvent[]
): Promise<CheckResult[]> {
  if (classifications.length === 0) return [];

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return classifications.map(({ rule }) =>
      unclear(rule, "no ANTHROPIC_API_KEY set in your environment — set it to the same key Claude Code already uses to run judgment checks")
    );
  }

  const client = new Anthropic({ apiKey });
  const transcriptText = summarizeEvents(events);

  return Promise.all(
    classifications.map(async ({ rule }) => {
      let response;
      try {
        response = await client.messages.create({
          model: MODEL,
          max_tokens: 512,
          tools: [RESULT_TOOL],
          tool_choice: { type: "tool", name: "report_result" },
          messages: [
            {
              role: "user",
              content: `Here is ONE rule from a CLAUDE.md/AGENTS.md file, and a transcript of a Claude Code session. Judge whether the session's behavior actually followed this rule. Report PASS if clearly followed, FAIL if clearly violated, UNCLEAR if the transcript doesn't give enough to judge either way — never guess PASS when you're not sure.\n\nRULE — ${rule.title}\n${rule.text}\n\nSESSION TRANSCRIPT:\n${transcriptText}`,
            },
          ],
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return unclear(rule, `API call failed (${message}) — could not run this check`);
      }

      const toolUseBlock = response.content.find(
        (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
      );
      if (!toolUseBlock) {
        return unclear(rule, "model did not return a structured result — could not run this check");
      }

      const parsed = toolUseBlock.input as { status?: string; evidence?: string };
      const status = parsed.status;
      if (status === "PASS" || status === "FAIL" || status === "UNCLEAR") {
        return { ruleId: rule.id, ruleTitle: rule.title, ruleSource: rule.source, status, evidence: parsed.evidence ?? "" };
      }
      return unclear(rule, "model response did not include a valid result for this rule");
    })
  );
}
