import Anthropic from "@anthropic-ai/sdk";
import type { Rule } from "../types.js";

const MODEL = "claude-sonnet-4-5-20250929";

export interface SplitBrainConflict {
  claudeMdRule: { id: string; title: string };
  agentsMdRule: { id: string; title: string };
  explanation: string;
}

export interface SplitBrainResult {
  ran: boolean;
  reason?: string;
  conflicts: SplitBrainConflict[];
}

const CONFLICT_TOOL = {
  name: "report_conflicts",
  description: "Report every genuine contradiction found between the two rule sets.",
  input_schema: {
    type: "object" as const,
    properties: {
      conflicts: {
        type: "array" as const,
        items: {
          type: "object" as const,
          properties: {
            claudeMdRuleId: { type: "string" as const },
            agentsMdRuleId: { type: "string" as const },
            explanation: { type: "string" as const, description: "One sentence: what each file says, and why they conflict." },
          },
          required: ["claudeMdRuleId", "agentsMdRuleId", "explanation"],
        },
      },
    },
    required: ["conflicts"],
  },
};

/**
 * Finds genuine contradictions between a project's CLAUDE.md and AGENTS.md
 * — two rules that a coding agent literally cannot satisfy both of at once
 * (e.g. one says "never commit directly to main," the other says "always
 * commit directly to main for hotfixes"). Overlapping-but-consistent rules,
 * or rules on unrelated topics, are not conflicts — only tell the model to
 * report cases where following one rule means violating the other.
 *
 * This is a judgment task (needs actual reading comprehension across two
 * documents), so it needs the same LLM-judgment machinery and the same
 * fail-closed discipline as judgmentChecks.ts: no key or any API problem
 * means "could not check," never a false "no conflicts found."
 */
export async function findSplitBrainConflicts(claudeMdRules: Rule[], agentsMdRules: Rule[]): Promise<SplitBrainResult> {
  if (claudeMdRules.length === 0 || agentsMdRules.length === 0) {
    return { ran: false, reason: "needs both a CLAUDE.md and an AGENTS.md with at least one rule each to compare", conflicts: [] };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { ran: false, reason: "no ANTHROPIC_API_KEY set — split-brain check needs judgment, not just pattern matching", conflicts: [] };
  }

  const client = new Anthropic({ apiKey });
  const claudeMdText = claudeMdRules.map((r) => `[${r.id}] ${r.title}\n${r.text}`).join("\n\n");
  const agentsMdText = agentsMdRules.map((r) => `[${r.id}] ${r.title}\n${r.text}`).join("\n\n");

  let response;
  try {
    response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      tools: [CONFLICT_TOOL],
      tool_choice: { type: "tool", name: "report_conflicts" },
      messages: [
        {
          role: "user",
          content: `Here are the rules from a project's CLAUDE.md and its AGENTS.md. Find only GENUINE contradictions — cases where following one rule means violating the other, not just overlapping or related topics. Two rules that both address the same area but agree, or rules on unrelated topics, are NOT conflicts. If there are no real contradictions, report an empty conflicts array.\n\nCLAUDE.md RULES:\n${claudeMdText}\n\nAGENTS.md RULES:\n${agentsMdText}`,
        },
      ],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ran: false, reason: `API call failed (${message}) — could not run this check`, conflicts: [] };
  }

  const toolUseBlock = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use"
  );
  if (!toolUseBlock) {
    return { ran: false, reason: "model did not return a structured result — could not run this check", conflicts: [] };
  }

  const parsed = toolUseBlock.input as {
    conflicts?: Array<{ claudeMdRuleId?: string; agentsMdRuleId?: string; explanation?: string }>;
  };

  const conflicts: SplitBrainConflict[] = [];
  for (const c of parsed.conflicts ?? []) {
    const claudeRule = claudeMdRules.find((r) => r.id === c.claudeMdRuleId);
    const agentsRule = agentsMdRules.find((r) => r.id === c.agentsMdRuleId);
    if (claudeRule && agentsRule && c.explanation) {
      conflicts.push({
        claudeMdRule: { id: claudeRule.id, title: claudeRule.title },
        agentsMdRule: { id: agentsRule.id, title: agentsRule.title },
        explanation: c.explanation,
      });
    }
  }

  return { ran: true, conflicts };
}
