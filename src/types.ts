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
  status: CheckStatus;
  evidence: string;
}
