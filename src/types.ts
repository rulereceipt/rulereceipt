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
}
