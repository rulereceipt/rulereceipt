export interface Rule {
  id: string;
  title: string;
  text: string;
  source: "global" | "project";
  kind?: "deterministic" | "judgment";
}

export interface TranscriptEvent {
  role: "user" | "assistant" | "tool";
  toolName?: string;
  content: string;
  timestamp?: string;
}

export type CheckStatus = "PASS" | "FAIL" | "UNCLEAR";

export interface CheckResult {
  ruleId: string;
  ruleTitle: string;
  status: CheckStatus;
  evidence: string;
}
