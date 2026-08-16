import type { TranscriptEvent } from "../types.js";

/**
 * Day 1-2: locate and read the most recent local Claude Code session
 * transcript (JSONL) and normalize it into an ordered list of events
 * (messages + tool calls). No API calls — this is a pure local file read.
 */
export function readLatestTranscript(_projectPath: string): TranscriptEvent[] {
  throw new Error("TODO: implement — start here Day 1");
}
