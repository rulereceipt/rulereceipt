import type { TranscriptEvent } from "../types.js";
import { segments } from "./shellCommand.js";

/**
 * SHADOW signal (not a verdict): did this session modify or bypass its own guard?
 * Raised by an HN question — the guard is Claude Code config the guarded agent can
 * reach (see KNOWN-GAPS). Two hard-evidence signals, read straight from the
 * transcript:
 *   - a Write/Edit to a hooks/settings file (.claude/settings*.json, a .codex hook
 *     config, .git/hooks/*, .githooks/*)
 *   - a `git … --no-verify` command (skips the pre-push hook), reported only when a
 *     branch rule exists to bypass
 *
 * It reports a FACT ("guard modified/bypassed this session"), never a Broken
 * verdict: a settings edit can be perfectly legitimate. It is kept out of the
 * pass/fail counts and the exit code until its false-accusation rate is measured
 * on the frozen corpus — this is the shadow stage.
 */

export interface GuardTamperFinding {
  kind: "hook-config-edit" | "no-verify";
  evidence: string;
}

// Paths whose edit means the guard's own wiring changed.
const HOOK_CONFIG_PATH =
  /(^|\/)\.claude\/settings(\.[^/]*)?\.json$|(^|\/)\.codex\/[^\s]*hook|(^|\/)\.git\/hooks\/[^/\s]+$|(^|\/)\.githooks\/[^/\s]+$/i;

function editedPath(e: TranscriptEvent): string | null {
  if (e.kind !== "tool_use") return null;
  if (e.toolName !== "Write" && e.toolName !== "Edit" && e.toolName !== "NotebookEdit") return null;
  const input = e.input as { file_path?: unknown; notebook_path?: unknown } | null;
  const p = typeof input?.file_path === "string" ? input.file_path : typeof input?.notebook_path === "string" ? input.notebook_path : null;
  return p;
}

/**
 * @param hasBranchRule whether a branch-policy rule is loaded — a `--no-verify`
 * is only reported as a bypass when there is a branch rule for it to skip.
 */
export function detectGuardTamper(events: TranscriptEvent[], opts: { hasBranchRule: boolean }): GuardTamperFinding[] {
  const out: GuardTamperFinding[] = [];
  const seen = new Set<string>();
  for (const e of events) {
    const p = editedPath(e);
    if (p && HOOK_CONFIG_PATH.test(p)) {
      const key = `edit:${p}`;
      if (!seen.has(key)) { seen.add(key); out.push({ kind: "hook-config-edit", evidence: `edited the hook/settings file ${p}` }); }
    }
    if (opts.hasBranchRule && e.kind === "tool_use" && e.toolName === "Bash") {
      const cmd = (e.input as { command?: unknown } | null)?.command;
      if (typeof cmd === "string") {
        for (const seg of segments(cmd)) {
          if (/\bgit\b/.test(seg) && /(^|\s)--no-verify(\s|=|$)/.test(seg) && !/\bgit\b[^\n]*\bconfig\b/.test(seg)) {
            const key = `nv:${seg.slice(0, 80)}`;
            if (!seen.has(key)) { seen.add(key); out.push({ kind: "no-verify", evidence: `ran a git command with --no-verify (skips the pre-push guard): ${seg.replace(/\s+/g, " ").trim().slice(0, 100)}` }); }
          }
        }
      }
    }
  }
  return out;
}

/** Advisory lines for the report (shadow — printed only when there is a finding). */
export function renderGuardTamper(findings: GuardTamperFinding[]): string[] {
  if (findings.length === 0) return [];
  const out = ["", "Guard integrity (advisory — not a verdict, not counted):"];
  for (const f of findings) out.push(`  ⚠ ${f.evidence}`);
  out.push("  This session modified or bypassed the guard's own wiring. Legitimate or not, it's");
  out.push("  worth a look — enforcement that the session can edit isn't enforcement (see KNOWN-GAPS).");
  return out;
}
