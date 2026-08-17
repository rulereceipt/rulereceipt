import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import type { CheckResult } from "./types.js";

export interface HistoryEntry {
  timestamp: string;
  pass: number;
  fail: number;
  unclear: number;
  sessionFilePath: string | null;
}

function historyPath(): string {
  return join(homedir(), ".rulereceipt", "history.jsonl");
}

/**
 * One compact line per check run — counts only, never rule text or
 * evidence. This is what makes a later digest possible without storing
 * anything sensitive locally beyond what a single report already shows.
 */
export function appendHistory(results: CheckResult[], sessionFilePath: string | null): void {
  const entry: HistoryEntry = {
    timestamp: new Date().toISOString(),
    pass: results.filter((r) => r.status === "PASS").length,
    fail: results.filter((r) => r.status === "FAIL").length,
    unclear: results.filter((r) => r.status === "UNCLEAR").length,
    sessionFilePath,
  };
  const path = historyPath();
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  appendFileSync(path, JSON.stringify(entry) + "\n", "utf-8");
}

export function readHistorySince(sinceMs: number): HistoryEntry[] {
  const path = historyPath();
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf-8").split("\n").filter((l) => l.trim());
  const entries: HistoryEntry[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as HistoryEntry;
      if (new Date(parsed.timestamp).getTime() >= sinceMs) {
        entries.push(parsed);
      }
    } catch {
      continue;
    }
  }
  return entries;
}
