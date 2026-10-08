import { existsSync } from "node:fs";
import { join, delimiter } from "node:path";
import { ADAPTERS, EXPERIMENTAL_ADAPTERS, UNSUPPORTED_TOOLS } from "./adapters/index.js";

/**
 * The capability matrix (facts only). Built from the REAL adapter registry, so
 * it can't drift from what the code actually does — add an adapter and it shows
 * up here. It answers, honestly, three questions a new user asks: which agents
 * can you read, what can you actually check, and what can you NOT catch.
 *
 * "Read" status is separate from "validated": an adapter can parse a format
 * (`read: "full"`) while its end-to-end accuracy is still unproven on a real
 * personal session (`validated: false`) — the experimental adapters are exactly
 * that, and the matrix says so rather than implying more than we've shown.
 * (Claude Code and Codex are both validated end-to-end on real sessions.)
 */

export interface AgentCapability {
  tool: string;
  read: "full" | "experimental" | "none";
  validated: boolean;
  note: string;
}

// Tools whose end-to-end behaviour we have NOT yet validated on a real personal
// session — kept explicit so "we can parse it" is never shown as "we validated it".
const UNVALIDATED = new Set<string>([]); // codex validated on a real 0.160.1 rollout (2026-10-07)
const NOTES: Record<string, string> = {
  "claude-code": "full support — parsed and validated end-to-end",
  codex: "supported — validated on a real end-to-end rollout (CLI 0.160.1, 2026-10-07); reads rollout-*.jsonl and compressed .jsonl.zst (zst needs Node 22.15+), incl. the 0.160 exec-harness (exec_command / apply_patch)",
  "copilot-cli": "supported — validated on a real session (CLI 1.0.92, 2026-10-07); reads events.jsonl incl. apply_patch edits and the ask-user/permission approval step (a human-approved action reads as Followed)",
  "gemini-cli": "legacy / untested — the standalone Gemini CLI refuses a personal Google login (\"client no longer supported, migrate to Antigravity\"), so there is no real session to validate against; use Antigravity instead",
  antigravity: "supported — validated on a real session (CLI 1.3.1, 2026-10-08); reads ~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl (PLANNER_RESPONSE tool_calls + GENERIC outputs), incl. an approved push to main (user said yes -> git push ran, exit 0 -> Followed)",
  cursor: "supported — validated on a real session (agent v2026.10.01, 2026-10-08); reads the agent-transcripts JSONL (message-wrapped lines, JSON-string tool input, <user_query> unwrap)",
};

export function agentCapabilities(): AgentCapability[] {
  const rows: AgentCapability[] = [];
  for (const a of ADAPTERS) {
    rows.push({ tool: a.tool, read: "full", validated: !UNVALIDATED.has(a.tool), note: NOTES[a.tool] ?? (UNVALIDATED.has(a.tool) ? "in testing" : "supported") });
  }
  for (const a of EXPERIMENTAL_ADAPTERS) {
    rows.push({ tool: a.tool, read: "experimental", validated: false, note: NOTES[a.tool] ?? "experimental — reader exists, awaiting real + planted + clean fixtures" });
  }
  for (const u of UNSUPPORTED_TOOLS) {
    rows.push({ tool: u.tool, read: "none", validated: false, note: u.reason });
  }
  return rows;
}

/** What each check method inspects — plain descriptions, no claims of certainty. */
export const CHECK_METHODS: { method: string; checks: string }[] = [
  { method: "text_scan", checks: "a literal string a rule forbids/requires, matched in the right places only (not in prose or tool output)" },
  { method: "git_events", checks: "branch policy — a push/commit/merge to a branch a rule names (e.g. main)" },
  { method: "file_events", checks: "a file a rule protects being created, overwritten, or deleted" },
  { method: "code_content", checks: "a forbidden/required code construct actually written through Write/Edit (ignores comments and strings)" },
  { method: "edit_test_pairing", checks: "'if you edit X, run the tests' — a code edit followed (or not) by a test run" },
  { method: "claim_vs_evidence", checks: "a 'tests pass' / 'done' claim backed (or not) by a real command and its output" },
  { method: "approval_gate", checks: "a push/commit/PR/delete done with — or without — the approval a rule requires (incl. revoked approval)" },
  { method: "emoji_output", checks: "emoji in committed output when a rule forbids it" },
  { method: "attribution_scan", checks: "an AI-attribution trailer in a commit/PR when a rule forbids it" },
  { method: "model_judgment", checks: "nothing mechanically — a judgment-call rule is reported as such, never faked into pass/fail" },
];

/** What the guard CANNOT catch — stated up front, not buried. */
export const GUARD_LIMITS: string[] = [
  "a read of a protected file whose name the command does not contain (e.g. `cat *` / a glob) — the guard sees the command text, not what it resolves to",
  "a command whose dangerous part is encoded or computed at runtime (a base64 blob piped to a shell, a target injected by xargs/a variable)",
  "anything outside a PreToolUse tool call — it guards tool calls, it does not make the model obey",
];

/**
 * Companion tools that do a DIFFERENT, complementary job — surfaced so a user
 * isn't told to pick. agnix lints the rules FILE (quality, structure, conflicts);
 * RuleReceipt checks the agent's BEHAVIOUR against it. They sit on either side of
 * the same problem, so doctor names agnix whether or not it's installed, and says
 * when it found it on your PATH.
 */
export interface Companion {
  name: string;
  installed: boolean;
  note: string;
}

function onPath(bin: string): boolean {
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const d of dirs) {
    try {
      if (existsSync(join(d, bin)) || existsSync(join(d, `${bin}.exe`)) || existsSync(join(d, `${bin}.cmd`))) return true;
    } catch {
      /* unreadable PATH entry: skip */
    }
  }
  return false;
}

export function companions(): Companion[] {
  return [
    {
      name: "agnix",
      installed: onPath("agnix"),
      note: "lints your rules FILE (structure, quality, conflicting lines). RuleReceipt checks what the agent actually DID with it — complementary, use both.",
    },
  ];
}

export interface CapabilityReport {
  agents: AgentCapability[];
  methods: typeof CHECK_METHODS;
  guardLimits: string[];
  companions: Companion[];
}

export function capabilityReport(): CapabilityReport {
  return { agents: agentCapabilities(), methods: CHECK_METHODS, guardLimits: GUARD_LIMITS, companions: companions() };
}

export function renderCapabilities(r: CapabilityReport): string {
  const out: string[] = [];
  const badge = (a: AgentCapability) => (a.read === "full" ? (a.validated ? "supported" : "in testing") : a.read === "experimental" ? "experimental" : "not supported");
  out.push("Agents RuleReceipt can read:");
  for (const a of r.agents) out.push(`  ${a.tool.padEnd(13)} ${badge(a).padEnd(14)} ${a.note}`);
  out.push("");
  out.push("What it checks (and how):");
  for (const m of r.methods) out.push(`  • ${m.checks}`);
  out.push("");
  out.push("What it CANNOT catch (by design — it detects and reports, it does not force the model to obey):");
  for (const l of r.guardLimits) out.push(`  • ${l}`);
  if (r.companions.length > 0) {
    out.push("");
    out.push("Companion tools (different job, use alongside):");
    for (const c of r.companions) out.push(`  • ${c.name}${c.installed ? " (found on your PATH)" : ""} — ${c.note}`);
  }
  return out.join("\n");
}
