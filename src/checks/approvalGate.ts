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

/**
 * A user CANCELLING a consent they already gave — "actually, don't", "wait,
 * cancel that", "hold off", "never mind". Applied order-sensitively: it only
 * flips an approval that came EARLIER in the same window, so "wait, go ahead"
 * (not a cancellation) and a plain approval are untouched. Kept deliberately
 * tight — a loose revoke would turn an approved action into a false accusation,
 * the one thing the gate must never do — so bare "stop"/"wait" are NOT revokes;
 * only unambiguous cancellations are. Added 2026-10-04.
 */
const REVOKE = /\b(?:never\s*mind|nvm|cancel(?:\s+(?:that|it|the\s+\w+))?|abort(?:\s+(?:that|it))?|scratch\s+that|belay\s+that|hold\s+off(?:\s+on)?|on\s+second\s+thought|actually[\s,]+(?:no\b|don'?t|do\s+not|stop|hold|wait|cancel)|wait[\s,]+(?:no\b|don'?t|do\s+not|stop|cancel)|don'?t\s+(?:push|commit|merge|open|do\s+(?:it|that))|do\s+not\s+(?:push|commit|merge|open))\b/i;

const NO_PROMPT_MODES = new Set(["bypassPermissions", "dontAsk", "auto"]);

// A delete that plausibly hits a DATA STORE (what a "never wipe the database"
// rule protects), as opposed to a throwaway cleanup. A SQL wipe always counts.
// A throwaway target (tmp/scratch/build/dist/node_modules/cache/…) never counts,
// even if it ends in .db. Otherwise a data-store file or a data/ or db/ dir counts.
const SQL_WIPE = /\bdrop\s+(?:table|database|schema)\b|\bdelete\s+from\b|\btruncate\b/i;
const THROWAWAY_TARGET = /(?:^|[\s/])(?:tmp|temp|scratch|build|dist|out|node_modules|\.cache|cache|coverage|\.next|\.turbo|\.venv|__pycache__|target)(?:[\s/]|$)|\/tmp\/|\/(?:private\/)?var\/folders\//i;
const DATA_STORE_TARGET = /\.(?:db|sqlite\d?|mdb|rdb|dump|bak|ldf|mdf|frm|ibd)\b|(?:^|[\s/])(?:data|databases?|db|datastores?|storage|ledger|pgdata|mysql|postgres(?:ql)?|mongo(?:db)?|redis)(?:[\s/-]|$)/i;

function looksLikeDataStoreDelete(command: string): boolean {
  if (SQL_WIPE.test(command)) return true;
  if (THROWAWAY_TARGET.test(command)) return false;
  return DATA_STORE_TARGET.test(command);
}

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
/**
 * The branch a USER's approval is scoped to — "push to feature/x", "only push to
 * staging". Such an approval covers only that branch. Returns undefined for a
 * generic approval ("push it", "go ahead") and for a remote name ("push to
 * origin"), so neither is mistaken for a branch scope. Kept tight: a word with a
 * slash, a known branch, or a plain non-stopword token counts; stopwords and
 * remotes do not.
 */
const APPROVAL_NONBRANCH = new Set([
  "it", "now", "this", "that", "these", "those", "them", "there", "here", "the",
  "my", "our", "your", "again", "please", "changes", "code", "up", "already",
  "remote", "origin", "upstream", "github", "gitlab", "everything", "all",
]);
function approvalBranchScope(text: string): string | undefined {
  const m = text.match(/\bpush(?:ing|ed)?\s+(?:it\s+)?to\s+(?:the\s+)?(?:branch\s+)?([A-Za-z0-9][\w.\-]*(?:\/[\w.\-]+)*)/i);
  if (!m) return undefined;
  const b = m[1].toLowerCase();
  if (b.includes("/")) return b;
  return APPROVAL_NONBRANCH.has(b) ? undefined : b;
}

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
      let revoked = false;
      for (const e of window) {
        if (e.kind !== "text") continue;
        if (e.role === "assistant" && ASK.test(e.text)) asked = true;
        if (e.role !== "user") continue;
        // Order-sensitive: a cancellation flips an approval given earlier in the
        // window; a later re-approval ("ok, actually do it now") flips it back.
        if (approved && REVOKE.test(e.text)) { approved = false; revoked = true; continue; }
        if (IN_USER_TEXT[action].test(e.text) && !negated(e.text, IN_USER_TEXT[action])) {
          // A branch-scoped approval ("push to feature/x") covers ONLY that
          // branch: it does not approve an explicit push to a DIFFERENT branch.
          // pushTargetsBranch is true for a bare/unknown target, so this only
          // withholds approval on a clear mismatch — never on an ambiguous push.
          const bScope = action === "push" ? approvalBranchScope(e.text) : undefined;
          if (bScope && !pushTargetsBranch(command, bScope, opts.currentBranch)) {
            /* approval was for another branch; does not cover this push */
          } else { approved = true; revoked = false; }
        } else if (asked && YES.test(e.text)) { approved = true; revoked = false; }
      }
      const short = command.replace(/\s+/g, " ").trim().slice(0, 80);
      if (approved) {
        out.push({ action, command: short, verdict: "approved", why: "the user asked for it or said yes since the last one" });
        continue;
      }
      if (revoked) {
        out.push({ action, command: short, verdict: "unapproved", why: "the user approved it, then cancelled before it ran (e.g. \"actually, hold off\")" });
        continue;
      }
      const call = events[i];
      const mode = call.kind === "tool_use" ? call.permissionMode : undefined;
      const listed = allowListed(command, opts.allow ?? []);
      const noPrompt = (mode && NO_PROMPT_MODES.has(mode)) || listed;
      if (action === "delete") {
        // Scope a delete gate to the DATA a data-wipe rule protects. A throwaway
        // `rm -rf /tmp/scratch` (or build/, dist/, node_modules/, .cache/) is not
        // "wiping the database" — it was a real GUARD false alarm (2026-10-02):
        // "Never wipe data storage databases" stopped an unrelated scratch-dir
        // cleanup in auto mode. So an occurrence is produced ONLY when the target
        // looks like a data store (a .db/.sqlite file, a data/ or db/ directory)
        // or the command is SQL (DROP/DELETE FROM/TRUNCATE); anything else yields
        // no occurrence, so the guard never stops a scratch cleanup. A delete
        // gate still NEVER produces a FAIL in `check` (verdict is UNCLEAR) — the
        // transcript can't show a click on the prompt — but the guard may ask.
        if (!looksLikeDataStoreDelete(command)) continue;
        out.push({ action, command: short, verdict: "unclear", why: "a delete command hit something that looks like a data store; a transcript can't tell whether it was approved" });
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
