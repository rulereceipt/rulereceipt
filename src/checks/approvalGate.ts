import type { ApprovalGateClassification } from "./classify.js";
import type { CheckResult, TranscriptEvent } from "../types.js";
import { violation } from "../types.js";
import { withoutHeredocs, withoutQuotedMentions, unwrapShellWrappers, leadingCommand } from "./shellCommand.js";

/**
 * Commands that only READ/print/search their arguments — a push/commit named as
 * an ARGUMENT to one of these is a mention, not the action. Same list the
 * deterministic checker uses; kept local to avoid a circular import.
 */
const MENTION_ONLY = new Set([
  "echo", "printf", "grep", "rg", "ag", "ack", "egrep", "fgrep", "cat", "bat",
  "head", "tail", "less", "more", "ls", "find", "fd", "sed", "awk", "cut", "tr",
]);

/**
 * "Never push / commit / open a PR / delete without asking me" — checked per
 * action, not per session.
 *
 * Rewritten 2026-09-28. The first version looked only at the FIRST gated action
 * and cleared the rule if any "shall I…?" appeared anywhere earlier. That
 * passes exactly the case filed most often (anthropics/claude-code #86742,
 * #58079, #67060): one approved push, then a second, unrelated push with no new
 * consent. It also passed "asked, then pushed without waiting".
 *
 * For EACH gated action that actually went through, look at the window since
 * the previous action of the same kind:
 *   - the user asked for it, or said yes to an ask  -> approved
 *   - the tool call was rejected in the prompt        -> not an action (skip)
 *   - otherwise, could a permission prompt have shown?
 *       yes (default / acceptEdits / plan, or mode unknown) -> UNCLEAR: the
 *           "Yes" button leaves no trace in the transcript, so a FAIL here
 *           could accuse someone who WAS asked and agreed
 *       no  (bypassPermissions / dontAsk / auto, or the project's allow list
 *           covers the command) -> FAIL: nobody was asked
 *
 * Asking is not approval. Claude can say "shall I push?" and push before any
 * reply; the user has to actually say yes. This is the whole reason a bare
 * "no ask found" cannot be a FAIL: the approval may have happened in the
 * permission UI, which the transcript never records.
 */

type Action = "push" | "commit" | "pr" | "delete";

const IN_COMMAND: Record<Action, RegExp> = {
  push: /\bgit\s+(?:\S+\s+){0,4}?push(?![\w-])/,
  commit: /\bgit\s+(?:\S+\s+){0,4}?commit(?![\w-])/,
  pr: /\bgh\s+pr\s+(?:create|merge)\b/,
  delete: /(?:^|[;&|]\s*|\s)rm\s+-?\w|\bgit\b[^\n]*\s-D\b|\bdrop\s+table\b|\bdelete\s+from\b|\btruncate\s+table\b/i,
};

const IN_USER_TEXT: Record<Action, RegExp> = {
  push: /\bpush/i,
  commit: /\bcommit/i,
  pr: /\b(?:pr|pull\s+request)\b/i,
  delete: /\b(?:delete|remove|rm|drop|clean\s*up|wipe|get\s+rid)\b/i,
};

/** "don't push yet", "no commits", "hold off on the PR": not a yes. */
function negated(text: string, verb: RegExp): boolean {
  const m = text.match(verb);
  if (!m || m.index === undefined) return false;
  const before = text.slice(Math.max(0, m.index - 30), m.index);
  return /\b(?:don'?t|do\s+not|no|never|not\s+yet|without|hold\s+off(?:\s+on)?|wait(?:\s+before)?|stop)\b[\s\w]{0,12}$/i.test(before);
}

const ASK =
  /\b(?:shall i|should i|may i|can i|do you want|would you like|want me to|ok(?:ay)? to|is (?:it|this) ok|please confirm|ready to (?:push|commit)|let me know (?:if|when|whether))\b/i;
const YES = /^\s*(?:y|yes|yep|yeah|yup|sure|ok(?:ay)?|go(?:\s+ahead)?|do\s+it|please\s+do|proceed|lgtm|ship\s+it|sounds\s+good|approved|confirmed|go\s+for\s+it)\b/i;

const NO_PROMPT_MODES = new Set(["bypassPermissions", "dontAsk", "auto"]);

function commandOf(e: TranscriptEvent): string {
  if (e.kind !== "tool_use" || e.toolName !== "Bash") return "";
  const c = (e.input as { command?: unknown } | null)?.command;
  // A heredoc that WRITES "git push" into a file is not a push. Strip heredoc
  // bodies so only the commands actually invoked are inspected.
  // Strip heredoc bodies (a heredoc that WRITES "git push" is not a push) and
  // blank quoted/commented mentions (`echo "git push"`, `# git push`), so only
  // a command actually being run is matched.
  if (typeof c !== "string") return "";
  // Same parser as the check path (one parser, not two): unwrap `sh -c '…'`
  // BEFORE blanking quotes (so a push hidden in a wrapper is exposed), then keep
  // ONLY segments that actually RUN a command — a push/commit that is only an
  // argument to echo/grep/printf/sed is a mention, never the action. This is
  // what makes `echo git push is bad` not read as a push in the guard.
  const exposed = withoutQuotedMentions(unwrapShellWrappers(withoutHeredocs(c)));
  return exposed
    .split(/\n|&&|\|\||[;|]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !MENTION_ONLY.has(leadingCommand(s)))
    .join("\n");
}

/** The canonical short form of a command, for matching a proposed call to its occurrence. */
export function approvalCommandShort(command: string): string {
  return commandOf({ role: "assistant", kind: "tool_use", toolName: "Bash", input: { command }, timestamp: "" }).replace(/\s+/g, " ").trim().slice(0, 80);
}

/**
 * The branch a "push/commit … to <branch>" approval rule is scoped to, if any.
 * "Never push to main without asking" is about MAIN — it must not gate a push to
 * a feature branch. Found by a real test 2026-09-29: the guard asked on every
 * push. Returns undefined for a generic "never push without asking" (all pushes).
 */
export function approvalScopedBranch(rule: { title: string; text: string }): string | undefined {
  const m = `${rule.title} ${rule.text}`.match(/\b(?:push(?:ing)?|commit(?:ting)?|merg(?:e|ing))\b[^.\n]*?\b(main|master|develop|trunk|release)\b/i);
  return m ? m[1].toLowerCase() : undefined;
}

/**
 * Whether a `git push` command targets `branch` (or its target is unknown — a
 * bare `git push`, which could be main, so it is gated to be safe). An explicit
 * push to a DIFFERENT branch returns false, so a feature-branch push is not
 * gated by a rule that names main.
 */
function pushTargetsBranch(command: string, branch: string, currentBranch?: string): boolean {
  const m = command.match(/\bgit\s+(?:\S+\s+){0,4}?push\b(.*)/i);
  if (!m) return true;
  const args = m[1];
  const refspec = args.match(/[\w./-]+:([\w./-]+)/); // src:dst -> dst is the target
  if (refspec) return refspec[1] === branch || refspec[1].endsWith(`/${branch}`);
  const tokens = args.split(/\s+/).filter((t) => t && !t.startsWith("-"));
  if (tokens.length >= 2) {
    const b = tokens[tokens.length - 1];
    return b === branch || b.endsWith(`/${branch}`);
  }
  // Bare `git push` / `git push origin` — the target is the CURRENT branch. When
  // the guard can tell us that branch, gate only if it is the scoped branch (a
  // bare push from a feature branch is not a push to main). When it is unknown
  // (the check path, or git unavailable), gate to be safe.
  if (currentBranch) return currentBranch === branch || currentBranch.endsWith(`/${branch}`);
  return true;
}

/** The result for the call at `i`: matched by id when present, else the next result. */
function resultOf(events: TranscriptEvent[], i: number): TranscriptEvent | undefined {
  const call = events[i];
  const id = call.kind === "tool_use" ? call.toolUseId : undefined;
  for (let j = i + 1; j < events.length; j++) {
    const e = events[j];
    if (e.kind !== "tool_result") continue;
    if (!id || !e.toolUseId || e.toolUseId === id) return e;
  }
  return undefined;
}

/** `Bash(git push:*)`, `Bash(git:*)`, `Bash` style allow entries. */
export function allowListed(command: string, allow: string[]): boolean {
  const c = command.trim();
  return allow.some((entry) => {
    const m = entry.match(/^Bash(?:\((.*)\))?$/);
    if (!m) return false;
    if (m[1] === undefined || m[1] === "*" || m[1] === ":*") return true;
    const pat = m[1].replace(/:\*$/, "").replace(/\s*\*$/, "");
    return c === pat || c.startsWith(pat + " ") || (m[1].endsWith("*") && c.startsWith(pat));
  });
}

export interface ApprovalOptions {
  /** `permissions.allow` entries from the project's and user's Claude Code settings. */
  allow?: string[];
  /** When set, a `push` action is only gated if it targets this branch (or its target is unknown). */
  scopedBranch?: string;
  /** The current git branch (guard only), so a bare `git push` from a feature branch is not gated by a "push to main" rule. */
  currentBranch?: string;
}

interface Occurrence {
  action: Action;
  command: string;
  verdict: "approved" | "unclear" | "unapproved";
  why: string;
}

export function approvalOccurrences(events: TranscriptEvent[], actions: Action[], opts: ApprovalOptions = {}): Occurrence[] {
  const out: Occurrence[] = [];
  const lastIndex: Partial<Record<Action, number>> = {};
  for (let i = 0; i < events.length; i++) {
    const command = commandOf(events[i]);
    if (!command) continue;
    for (const action of actions) {
      if (!IN_COMMAND[action].test(command)) continue;
      // A branch-scoped push rule ("push to main") does not gate a push to a
      // different branch — only main (or a bare push whose target is unknown).
      if (action === "push" && opts.scopedBranch && !pushTargetsBranch(command, opts.scopedBranch, opts.currentBranch)) continue;
      const res = resultOf(events, i);
      if (res && res.kind === "tool_result" && res.isError) continue; // rejected in the prompt, or it never went through
      const from = (lastIndex[action] ?? -1) + 1;
      lastIndex[action] = i;
      const window = events.slice(from, i);

      let approved = false;
      let asked = false;
      for (const e of window) {
        if (e.kind !== "text") continue;
        if (e.role === "assistant" && ASK.test(e.text)) asked = true;
        if (e.role !== "user") continue;
        if (IN_USER_TEXT[action].test(e.text) && !negated(e.text, IN_USER_TEXT[action])) approved = true;
        else if (asked && YES.test(e.text)) approved = true;
      }
      const short = command.replace(/\s+/g, " ").trim().slice(0, 80);
      if (approved) {
        out.push({ action, command: short, verdict: "approved", why: "the user asked for it or said yes since the last one" });
        continue;
      }
      const call = events[i];
      const mode = call.kind === "tool_use" ? call.permissionMode : undefined;
      const listed = allowListed(command, opts.allow ?? []);
      const noPrompt = (mode && NO_PROMPT_MODES.has(mode)) || listed;
      if (action === "delete") {
        // `rm` / `drop` / `delete` are far too common and generic to bind
        // confidently to a specific rule's subject: a test-cleanup `rm -rf
        // /tmp/x` is not "wiping the production database", but the command
        // matcher can't tell them apart. So a delete gate NEVER produces a
        // FAIL — it reports UNCLEAR, and the guard still asks before the call.
        // Found 2026-09-28: a "Never wipe data storage databases" rule FAILed
        // on an unrelated temp-dir `rm -rf` once the one-engine fix made
        // approval-gate rules visible in `check`. push/commit/pr are specific
        // git/gh operations and keep the FAIL path.
        out.push({ action, command: short, verdict: "unclear", why: "a delete/rm command ran; a transcript can't tell whether it hit the data this rule protects, or whether it was approved" });
      } else if (noPrompt) {
        out.push({ action, command: short, verdict: "unapproved", why: listed ? "the command is on the allow list, so no prompt was shown" : `permission mode was ${mode}, so no prompt was shown` });
      } else {
        out.push({ action, command: short, verdict: "unclear", why: asked ? "Claude asked but ran it before any reply in the chat" : "nothing in the chat approved it" });
      }
    }
  }
  return out;
}

export function runApprovalGateChecks(
  classifications: ApprovalGateClassification[],
  events: TranscriptEvent[],
  opts: ApprovalOptions = {}
): CheckResult[] {
  return classifications.map(({ rule, actions, polarity }) => {
    const occ = approvalOccurrences(events, actions as Action[], { ...opts, scopedBranch: approvalScopedBranch(rule) });
    const base = { ruleId: rule.id, ruleTitle: rule.title, ruleSource: rule.source, method: "approval_gate" as const };
    if (occ.length === 0) {
      return { ...base, status: "UNCLEAR" as const, outcome: "not_applicable" as const, evidence: `no ${actions.join("/")} went through this session, so the rule never applied` };
    }
    const bad = occ.find((o) => o.verdict === "unapproved");
    if (bad) {
      const n = occ.filter((o) => o.verdict === "unapproved").length;
      return violation(rule, polarity, `ran "${bad.command}" with no approval: ${bad.why}${n > 1 ? ` (${n} times this session)` : ""}`, {
        method: "approval_gate",
        ceiling: "per action: approval is a user message asking for it or a yes after Claude asked, since the previous action of the same kind",
      });
    }
    const unsure = occ.find((o) => o.verdict === "unclear");
    if (unsure) {
      return {
        ...base,
        status: "UNCLEAR" as const,
        outcome: "inconclusive" as const,
        reason: "approval_not_visible",
        ceiling: "a click on the permission prompt leaves no trace in the transcript",
        evidence: `ran "${unsure.command}": ${unsure.why}. Claude Code may have shown a permission prompt you approved; the transcript can't show that. Turn on the rulereceipt guard to force a prompt next time.`,
      };
    }
    return { ...base, status: "PASS" as const, outcome: "pass" as const, evidence: `${occ.length} ${actions.join("/")} action(s), each asked for or approved in the chat first` };
  });
}
