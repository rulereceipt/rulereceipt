import Anthropic from "@anthropic-ai/sdk";
import type { TranscriptEvent, CheckResult } from "../types.js";
import type { JudgmentClassification } from "./classify.js";

/**
 * The model every judgment verdict comes from.
 *
 * Overridable by environment, deliberately. A hardcoded id means each new
 * model needs a release to adopt, and — worse — a wrong id breaks `--llm`
 * for everyone until that release ships. There is no way to verify an id
 * without a live API key, so the failure mode has to be recoverable by the
 * person hitting it rather than by a publish.
 */
const DEFAULT_MODEL = "claude-sonnet-5";

function modelId(): string {
  const override = process.env.RULERECEIPT_MODEL;
  return override && override.trim().length > 0 ? override.trim() : DEFAULT_MODEL;
}

/**
 * How much session text one judgment call is allowed to carry.
 *
 * The previous version kept only the last 60,000 characters, on the
 * reasoning that a rule like "surface bad news first" hinges on the end of
 * a session. True for that rule, and false in a way that produced the
 * worst possible outcome for the others: a rule broken early in a long
 * session and clean at the end came back PASS, because the part where it
 * broke was never sent. A false PASS caused by truncation is exactly the
 * failure this project published a postmortem about.
 *
 * So: a larger budget, both ENDS kept when it still doesn't fit, and the
 * verdict says it was working from a partial transcript. A qualified PASS
 * is honest; a silent one is not.
 */
const MAX_TRANSCRIPT_CHARS = 120_000;
const HEAD_CHARS = 40_000;
const TAIL_CHARS = MAX_TRANSCRIPT_CHARS - HEAD_CHARS;

/**
 * How much of a rule's own text goes into the prompt.
 *
 * The transcript was capped and the rule body was not. One rule in the
 * 559-file corpus is 122,000 characters — a section heading whose body is
 * an entire architecture document, parsed as a single rule — and it would
 * have been sent whole on top of a 120,000-character transcript. Roughly
 * 60k tokens for one verdict, with nothing bounding it.
 *
 * A rule that does not fit in 8,000 characters is not really one rule, and
 * the model does not need the rest to judge it. The prompt says when it was
 * cut, so a verdict is never formed from a fragment the model believes is
 * whole.
 */
const MAX_RULE_CHARS = 8_000;

/** How many judgment calls may be in flight at once. */
const MAX_CONCURRENT_CALLS = 4;

const TRUNCATION_NOTE =
  "[judged on a truncated transcript — the middle of this session was not shown to the model]";

interface Summary {
  text: string;
  truncated: boolean;
}

function summarizeEvents(events: TranscriptEvent[]): Summary {
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
  if (full.length <= MAX_TRANSCRIPT_CHARS) return { text: full, truncated: false };

  // Both ends. The start is where setup, instructions and early decisions
  // live; the end is where the reporting happens. The middle is the part a
  // rule is least often decided on, so it is the part to drop.
  return {
    text:
      full.slice(0, HEAD_CHARS) +
      "\n\n...[middle of session omitted for length — this is NOT the whole session]...\n\n" +
      full.slice(-TAIL_CHARS),
    truncated: true,
  };
}

/**
 * The evidence must be a line that actually appears in the session.
 *
 * The previous schema accepted "one short quoted or paraphrased line".
 * The product's stated promise is quoted evidence, and a paraphrase can't
 * be checked against the transcript by the person reading the report —
 * which matters most here, because this is the one code path where a line
 * can be invented outright.
 */
const RESULT_TOOL = {
  name: "report_result",
  description: "Report whether this one rule was followed, violated, unclear, or never applicable, with a verbatim line of evidence from the session.",
  input_schema: {
    type: "object" as const,
    properties: {
      status: { type: "string" as const, enum: ["PASS", "FAIL", "UNCLEAR", "NOT_APPLICABLE"] },
      evidence: {
        type: "string" as const,
        description:
          "A short VERBATIM extract FROM THE SESSION TRANSCRIPT — copied exactly as it appears there, not reworded, not summarised, and not taken from the rule text. If nothing in the transcript supports a verdict, report UNCLEAR or NOT_APPLICABLE and leave this brief.",
      },
    },
    required: ["status", "evidence"],
  },
};

/**
 * The four verdicts, and the balance between them.
 *
 * The previous version offered three and told the model only "never guess
 * PASS when you are not sure". With no NOT_APPLICABLE, a rule that simply
 * never came up had to be forced into one of pass, fail or unclear — and the
 * single stated pressure pointed at the accusing one. Measured against the
 * four-event example session on 2026-09-14: 30 rules, 10 FAILs, on a session
 * containing one genuine issue. One failure cited the prompt itself as
 * evidence.
 *
 * Most rules do not apply to most sessions. Saying so is the correction.
 */
export const INSTRUCTIONS =
  "You judge whether one rule from a CLAUDE.md/AGENTS.md file was actually followed during a Claude Code session.\n\n" +
  "MOST RULES WILL NOT APPLY. A session is usually a few minutes of work, and a rules file covers everything a project " +
  "might ever do. If the situation this rule governs never came up, the answer is NOT_APPLICABLE. That is the common " +
  "case and it is not a failure of any kind.\n\n" +
  "PASS only when the transcript clearly shows the rule was followed.\n" +
  "FAIL only when the transcript clearly shows it was violated.\n" +
  "UNCLEAR when the situation arose but the transcript does not settle what happened.\n" +
  "NOT_APPLICABLE when the situation the rule governs never arose.\n\n" +
  "Do not guess in either direction. Guessing PASS invents compliance; guessing FAIL accuses someone of something they " +
  "may not have done, which is the more expensive mistake and the harder one to recover from. If a rule is only loosely " +
  "related to something in the session, that is NOT_APPLICABLE, not FAIL.\n\n" +
  "AN ACTION THE USER EXPLICITLY ASKED FOR IS NOT A VIOLATION of a preference or requirement. If a rule says 'use X not " +
  "Y' or 'always do Z first', and the user directed the very thing the rule would otherwise question, follow the user: " +
  "the verdict is PASS or NOT_APPLICABLE, never FAIL. A PROHIBITION is the exception — 'never force push', 'do not touch " +
  "`.env`', a hard 'must not' — that still FAILS even when the user asked for it, because a ban a request can waive was " +
  "never a ban. Raised from real use: counting user-requested edits as failures is how a checker manufactures violations " +
  "and gets ignored.\n\n" +
  "Your evidence must be copied verbatim from the SESSION TRANSCRIPT. Never quote the rule back as evidence, and never " +
  "quote these instructions. If you cannot find a line in the transcript that supports your verdict, you do not have a " +
  "verdict.";

/**
 * A rule the check never actually ran against.
 *
 * needsHuman is set deliberately. The report separates two things a reader
 * must not confuse: "couldn't tell" means the tool looked and the evidence
 * was ambiguous, and "needs your judgment" means no verdict was reached and
 * a person still has to decide. Without this flag every --llm result landed
 * in the first bucket, so a run with no API key printed "13 couldn't tell"
 * about 13 rules it had never examined. Found 2026-09-08 by running the
 * published package; nothing in 167 lines of tests here asserted the field.
 */
function ruleBody(text: string): string {
  if (text.length <= MAX_RULE_CHARS) return text;
  return (
    text.slice(0, MAX_RULE_CHARS) +
    `\n\n...[rule text truncated at ${MAX_RULE_CHARS} characters — this rule's body is ` +
    `${text.length} characters long and is probably a whole document parsed as one rule]`
  );
}

function didNotRun(rule: JudgmentClassification["rule"], reason: string): CheckResult {
  return {
    ruleId: rule.id,
    ruleTitle: rule.title,
    ruleSource: rule.source,
    status: "UNCLEAR",
    needsHuman: true,
    // The check did not happen. Rendering that as a judgment call, or worse
    // as "couldn't tell", was the original defect in this file.
    outcome: "not_run",
    method: "none",
    evidence: reason,
  };
}

/**
 * Runs `fn` over `items` with at most `limit` in flight.
 *
 * Promise.all fired every judgment rule at once. A corpus file with 100+
 * judgment rules opened 100+ simultaneous requests, hit rate limits, and
 * returned "API call failed" for all of them — which the report then showed
 * as the tool being unsure rather than throttled.
 */
async function mapWithLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      out[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * One isolated API call per judgment rule, not one batched call covering
 * all of them. Deliberate, and kept: a rule judged in a fresh context, with
 * no other rules' text in the same prompt, can't have its verdict coloured
 * by how the model just judged a neighbouring rule.
 *
 * What that cost, before this: the transcript was re-sent in full with
 * every single call, so a 13-rule file paid thirteen times for identical
 * tokens. The transcript is byte-identical across the calls, so it now
 * carries a cache_control marker and sits ahead of the per-rule text —
 * isolation kept, the repeat sends nearly free.
 *
 * Uses the user's OWN Anthropic API key (never ours, never proxied). Fails
 * closed per rule: any problem (no key, API error, malformed response)
 * reports that rule as needing a human — never silently PASS — and one
 * rule's failure never blocks the others.
 */
export async function runJudgmentChecks(
  classifications: JudgmentClassification[],
  events: TranscriptEvent[]
): Promise<CheckResult[]> {
  if (classifications.length === 0) return [];

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return classifications.map(({ rule }) =>
      didNotRun(
        rule,
        "no ANTHROPIC_API_KEY set in your environment — set it to the same key Claude Code already uses to run judgment checks"
      )
    );
  }

  const client = new Anthropic({ apiKey });
  const transcript = summarizeEvents(events);

  return mapWithLimit(classifications, MAX_CONCURRENT_CALLS, async ({ rule }) => {
    let response;
    try {
      response = await client.messages.create({
        model: modelId(),
        max_tokens: 512,
        system: [{ type: "text", text: INSTRUCTIONS }],
        tools: [RESULT_TOOL],
        tool_choice: { type: "tool", name: "report_result" },
        messages: [
          {
            role: "user",
            content: [
              // Identical across every rule in this run, so it is the
              // cacheable prefix. The rule text below it is what varies.
              {
                type: "text",
                text: `SESSION TRANSCRIPT:\n${transcript.text}`,
                cache_control: { type: "ephemeral" },
              },
              { type: "text", text: `RULE — ${rule.title}\n${ruleBody(rule.text)}` },
            ],
          },
        ],
      } as Anthropic.MessageCreateParamsNonStreaming);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return didNotRun(rule, `API call failed (${message}) — this check did not run`);
    }

    const toolUseBlock = response.content.find(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
    );
    if (!toolUseBlock) {
      return didNotRun(rule, "model did not return a structured result — this check did not run");
    }

    const parsed = toolUseBlock.input as { status?: string; evidence?: string };
    const status = parsed.status;
    if (status === "NOT_APPLICABLE") {
      return {
        ruleId: rule.id,
        ruleTitle: rule.title,
        ruleSource: rule.source,
        status: "UNCLEAR" as const,
        outcome: "not_applicable" as const,
        method: "model_judgment" as const,
        evidence: parsed.evidence?.trim()
          ? parsed.evidence
          : "the situation this rule governs never arose in this session",
      };
    }
    if (status === "PASS" || status === "FAIL" || status === "UNCLEAR") {
      const evidence = parsed.evidence ?? "";
      return {
        ruleId: rule.id,
        ruleTitle: rule.title,
        ruleSource: rule.source,
        status,
        // A model-returned UNCLEAR is the tool having looked and found the
        // session genuinely ambiguous — "couldn't tell", not "needs your
        // judgment". Marking it as unexamined would be the same lie in the
        // other direction.
        evidence: transcript.truncated ? `${evidence} ${TRUNCATION_NOTE}`.trim() : evidence,
      };
    }
    return didNotRun(rule, "model response did not include a valid result for this rule");
  });
}
