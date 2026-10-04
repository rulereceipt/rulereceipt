import { ADAPTERS, EXPERIMENTAL_ADAPTERS, UNSUPPORTED_TOOLS } from "./adapters/index.js";

/**
 * The capability matrix (facts only). Built from the REAL adapter registry, so
 * it can't drift from what the code actually does — add an adapter and it shows
 * up here. It answers, honestly, three questions a new user asks: which agents
 * can you read, what can you actually check, and what can you NOT catch.
 *
 * "Read" status is separate from "validated": an adapter can parse a format
 * (`read: "full"`) while its end-to-end accuracy is still unproven on a real
 * personal session (`validated: false`) — Codex is exactly that today, and the
 * matrix says so rather than implying more than we've shown.
 */

export interface AgentCapability {
  tool: string;
  read: "full" | "experimental" | "none";
  validated: boolean;
  note: string;
}

// Tools whose end-to-end behaviour we have NOT yet validated on a real personal
// session — kept explicit so "we can parse it" is never shown as "we validated it".
const UNVALIDATED = new Set<string>(["codex"]);
const NOTES: Record<string, string> = {
  "claude-code": "full support — parsed and validated end-to-end",
  codex: "in testing — parser exists, not yet validated on a real personal rollout (.jsonl.zst not yet read; see KNOWN-GAPS)",
};

export function agentCapabilities(): AgentCapability[] {
  const rows: AgentCapability[] = [];
  for (const a of ADAPTERS) {
    rows.push({ tool: a.tool, read: "full", validated: !UNVALIDATED.has(a.tool), note: NOTES[a.tool] ?? (UNVALIDATED.has(a.tool) ? "in testing" : "supported") });
  }
  for (const a of EXPERIMENTAL_ADAPTERS) {
    rows.push({ tool: a.tool, read: "experimental", validated: false, note: "experimental — reader exists, awaiting real + planted + clean fixtures" });
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

export interface CapabilityReport {
  agents: AgentCapability[];
  methods: typeof CHECK_METHODS;
  guardLimits: string[];
}

export function capabilityReport(): CapabilityReport {
  return { agents: agentCapabilities(), methods: CHECK_METHODS, guardLimits: GUARD_LIMITS };
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
  return out.join("\n");
}
