export interface Rule {
  id: string;
  title: string;
  text: string;
  source: "global" | "project";
}

export interface TranscriptTextEvent {
  role: "user" | "assistant";
  kind: "text";
  text: string;
  timestamp: string;
}

export interface TranscriptToolUseEvent {
  role: "assistant";
  kind: "tool_use";
  toolName: string;
  input: unknown;
  timestamp: string;
}

export interface TranscriptToolResultEvent {
  role: "user";
  kind: "tool_result";
  content: string;
  isError: boolean;
  timestamp: string;
}

export type TranscriptEvent =
  | TranscriptTextEvent
  | TranscriptToolUseEvent
  | TranscriptToolResultEvent;

export type CheckStatus = "PASS" | "FAIL" | "UNCLEAR";

/**
 * Five outcomes, not three.
 *
 * From anthropics/claude-code#90542. The failure that started this was not a
 * bad matcher — it was vocabulary reuse. With no API key the tool printed
 * "13 couldn't tell", a phrase this codebase defines as "the tool looked and
 * the evidence was ambiguous", about thirteen rules it had never examined.
 * Once `not_run` is its own outcome that lie has nowhere to sit, however
 * good or bad the matcher is.
 *
 * `not_applicable` earns its place the same way. A session that never
 * touched git cannot have violated a git rule, and calling that "followed"
 * is how an empty transcript produced 2,770 green ticks across the 559-file
 * corpus — every one of them true and none of them meaning anything.
 */
export type CheckOutcome =
  | "pass"
  | "fail"
  /** It looked, and the evidence did not settle it. */
  | "inconclusive"
  /** No check happened: no key, an error, no ratified reading. */
  | "not_run"
  /** The trigger never fired, so there was nothing to judge. */
  | "not_applicable";

/** How a verdict was reached. A verdict with no method is a verdict with no standing. */
export type CheckMethod =
  | "text_scan"
  | "file_events"
  | "git_events"
  | "code_content"
  | "edit_test_pairing"
  | "claim_vs_evidence"
  | "model_judgment"
  /** Nothing ran. */
  | "none";

export interface CheckResult {
  ruleId: string;
  ruleTitle: string;
  ruleSource: "global" | "project";
  status: CheckStatus;
  evidence: string;
  /**
   * True when this rule was never mechanically answerable — a judgment
   * call like "surface bad news first", which has no command to inspect.
   *
   * Exists because collapsing these into a single UNCLEAR count made the
   * tool look broken. Measured across 40 real rules files: of the actual
   * rules people write, 47.8% are mechanically answerable and 52.2% are
   * judgment calls. Reporting "1 pass · 0 fail · 14 unclear" reads as
   * fourteen failures, when most of those were a human's call from the
   * start and the tool is working exactly as intended.
   *
   * "I could not determine this" and "this was always yours to decide"
   * are different statements, and a tool about honest reporting should
   * not blur them.
   */
  needsHuman?: boolean;

  /**
   * The outcome in the five-value vocabulary. Optional while the checkers
   * are migrated one at a time; `status` remains the fallback.
   */
  outcome?: CheckOutcome;

  /** How this verdict was reached. */
  method?: CheckMethod;

  /**
   * What this method is ALLOWED to claim.
   *
   * A text scan may say "no occurrence of these spellings in this scope".
   * It may not say "the act did not happen" — that PASS shipped for six
   * versions and passed a session that ran `git push -f`. The ceiling
   * travels with the verdict so the report cannot overclaim on its behalf.
   */
  ceiling?: string;

  /** Why an inconclusive or not_run outcome came out that way, e.g. scope_incomplete. */
  reason?: string;

  /**
   * Set when the rule's direction was inferred rather than read from an
   * explicit signal word — a bare imperative like "Use `npm`" taken as a
   * requirement.
   *
   * Named on the verdict so a measurement can split inferred rows from
   * explicit ones and settle whether the leftover is coverage or noise,
   * rather than the question being argued. Suggested on
   * anthropics/claude-code#90542.
   */
  polarityInferred?: boolean;
}

/**
 * A FAIL may only be constructed from a forbidding rule.
 *
 * This is the "cannot accuse" property as a compile-time invariant rather
 * than a convention. It held by inspection — every `status: "FAIL"` sat
 * inside a `polarity === "forbid"` branch — and inspection is exactly what
 * stops holding the day someone adds a require-FAIL path. Passing the
 * polarity in means a require branch cannot call this: `"require"` is not
 * assignable to `"forbid"`, and the build fails rather than a user being
 * accused of not doing something the tool guessed they had to do.
 */
export function violation(
  rule: { id: string; title: string; source: "global" | "project" },
  polarity: "forbid",
  evidence: string,
  extra: Partial<CheckResult> = {}
): CheckResult {
  return {
    ruleId: rule.id,
    ruleTitle: rule.title,
    ruleSource: rule.source,
    status: "FAIL",
    outcome: "fail",
    evidence,
    ...extra,
  };
}
