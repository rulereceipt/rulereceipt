import type { TranscriptEvent, CheckResult } from "../types.js";
import { violation } from "../types.js";
import type { CodeContentClassification } from "./classify.js";

/**
 * Second structured-check primitive: only scans the actual content of
 * real file edits for a code-construct pattern (e.g. `print(`,
 * `analytics.track(`) — never a Bash command string, never prose, never
 * tool_result. Real false-positive this fixes (found 2026-08-30, on the
 * same real session as the git-branch bug): even after excluding
 * tool_result from the generic deterministic check, a rule like "no
 * `print(` statements" still matched because the agent's own Bash
 * command MENTIONED the pattern as a search argument (e.g. `grep -rn
 * "print(" src/`) — no print statement was ever written into a file.
 *
 * Known, stated limitation: `content`/`new_string` are the confirmed
 * real field names for Write/Edit tool_use input; NotebookEdit's field
 * name is included as best-effort (not independently confirmed against a
 * real NotebookEdit transcript event before shipping this) — a session
 * that only writes matching code via NotebookEdit could under-report,
 * which fails toward UNCLEAR/PASS, not a fabricated FAIL.
 */
function editedContentFromEvent(event: TranscriptEvent): string | null {
  if (event.kind !== "tool_use") return null;
  const input = event.input as { content?: unknown; new_string?: unknown; new_source?: unknown };
  if (event.toolName === "Write" && typeof input?.content === "string") return input.content;
  if (event.toolName === "Edit" && typeof input?.new_string === "string") return input.new_string;
  if (event.toolName === "NotebookEdit" && typeof input?.new_source === "string") return input.new_source;
  return null;
}

/**
 * Whether the content contains this literal AS A CALL, not merely as a
 * substring of a longer identifier.
 *
 * Found 2026-09-15 by checking a corpus FAIL rather than assuming it was
 * legitimate: a rule forbidding `fetch()` matched a file containing
 * `_metar_fetch()`. The literal was present verbatim, and entirely the wrong
 * function. The same bare-substring test makes `main()` match `domain()` and
 * `run()` match `rerun()`, and short generic call names are exactly what
 * these rules tend to name.
 *
 * Only the LEADING boundary is checked. The trailing side is already pinned
 * by the pattern itself — every literal reaching this checker ends in an
 * open paren or a call — so requiring a boundary after it would reject the
 * arguments.
 */
/**
 * The token sits inside a natural-language sentence (a lowercase word + space
 * right before it, and a space + lowercase word right after) — a MENTION, not
 * code. Found on unseen data 2026-09-29: "Avoid `try-catch` in hot paths" FAILed
 * (and the guard blocked a Write) because "try-catch" appears in the prose
 * "...use a try-catch block...". A real import (`from "lucide-react"`) is not
 * sandwiched in prose (it is bounded by quotes), so it still matches.
 */
function isProseSandwich(content: string, at: number, pattern: string): boolean {
  const before = content.slice(Math.max(0, at - 12), at);
  const after = content.slice(at + pattern.length, at + pattern.length + 12);
  return /[a-z]\s$/.test(before) && /^\s[a-z]/.test(after);
}

/**
 * Strip comments (always) and, when `dropStrings`, string literals — so a
 * forbidden token that appears only in a comment ("// never use console.log(")
 * or inside a string is not read as a real construct. Found by fa-corpus-v2
 * (2026-10-04): a `console.log(` in a comment produced a false accusation.
 *
 * Strings are KEPT for a non-call token, because an import specifier legitimately
 * lives in quotes (`from "lucide-react"`); they are DROPPED only for a call
 * pattern, where a token inside a string is not a call. Strings are consumed
 * before comments so a `//` or `#` inside a string is not mistaken for one, and
 * `#` is a comment only at a line start or after whitespace (so a TS private
 * field like `this.#count` survives).
 */
function stripCode(src: string, dropStrings: boolean): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      if (!dropStrings) {
        out += c; i++;
        while (i < n && src[i] !== c) { if (src[i] === "\\" && i + 1 < n) { out += src[i] + src[i + 1]; i += 2; continue; } out += src[i]; i++; }
        if (i < n) { out += src[i]; i++; }
      } else {
        const quote = c; i++;
        while (i < n && src[i] !== quote) { if (src[i] === "\\") i++; i++; }
        if (i < n) i++;
        out += " ";
      }
      continue;
    }
    if (c === "/" && src[i + 1] === "*") { i += 2; while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; out += " "; continue; }
    if (c === "/" && src[i + 1] === "/") { while (i < n && src[i] !== "\n") i++; continue; }
    if (c === "#" && (i === 0 || /\s/.test(src[i - 1]))) { while (i < n && src[i] !== "\n") i++; continue; }
    out += c; i++;
  }
  return out;
}

function containsCall(content: string, pattern: string): boolean {
  const isCall = pattern.endsWith("(");
  const leadsWithIdentifier = /^[A-Za-z0-9_$]/.test(pattern);
  if (!leadsWithIdentifier) {
    // A CALL like `.forEach(` legitimately follows an object (`arr.forEach()`),
    // so member access before it is fine — bare containment.
    if (pattern.endsWith("(")) return content.includes(pattern);
    // A punct-leading NON-call token (a dotfile/extension like `.env`, `.log`)
    // sitting right after an identifier is a property access or the tail of a
    // longer token, not the token itself: `.env` inside `process.env` is not
    // the .env file. Require a non-identifier char (or the start) before it.
    // Found in the false-accusation corpus run 2026-09-29 — a `.env` rule
    // FAILed every file using `process.env`.
    let fromPunct = 0;
    for (;;) {
      const at = content.indexOf(pattern, fromPunct);
      if (at === -1) return false;
      const before = at === 0 ? "" : content[at - 1];
      if (!/[A-Za-z0-9_$]/.test(before)) return true;
      fromPunct = at + 1;
    }
  }
  let from = 0;
  for (;;) {
    const at = content.indexOf(pattern, from);
    if (at === -1) return false;
    const before = at === 0 ? "" : content[at - 1];
    // A `.` before the pattern is a member-access SEPARATOR, not identifier
    // continuation — `analytics.track(` is a real call to `track(`. So `.` is
    // NOT in the disqualifying class (fixed 2026-09-26); `_` still is, so
    // `_metar_fetch(` does not match `fetch(`.
    if (!/[A-Za-z0-9_$]/.test(before)) {
      // A non-call token embedded in a prose sentence is a mention, not code.
      if (!isCall && isProseSandwich(content, at, pattern)) { from = at + 1; continue; }
      return true;
    }
    from = at + 1;
  }
}

export function runCodeContentChecks(
  classifications: CodeContentClassification[],
  events: TranscriptEvent[]
): CheckResult[] {
  // Per edited file: the raw content (for the evidence quote), plus comment-free
  // views. `codeOnly` also drops string literals (used for call patterns, where a
  // token inside a string isn't a call); `noComments` keeps strings (used for
  // import/value tokens, whose specifier legitimately lives in quotes).
  const editedContents: { raw: string; codeOnly: string; noComments: string }[] = [];
  for (const event of events) {
    const content = editedContentFromEvent(event);
    if (content) editedContents.push({ raw: content, codeOnly: stripCode(content, true), noComments: stripCode(content, false) });
  }

  return classifications.map(({ rule, patterns, polarity, polarityInferred }) => {
    let foundPattern: string | undefined;
    let foundContent: string | undefined;
    for (const content of editedContents) {
      for (const pattern of patterns) {
        const hay = pattern.endsWith("(") ? content.codeOnly : content.noComments;
        if (containsCall(hay, pattern)) {
          foundPattern = pattern;
          foundContent = content.raw;
          break;
        }
      }
      if (foundPattern) break;
    }

    if (polarity === "forbid") {
      if (foundPattern && foundContent) {
        return violation(rule, polarity, `found "${foundPattern}" actually written into a file: ${foundContent.slice(0, 160)}`, { method: "code_content", polarityInferred });
      }
        // Trigger evaluated and absent: the rule never applied. Not
        // "followed" — that word claims something the check cannot show.
      return {
        ruleId: rule.id,
        ruleTitle: rule.title,
        ruleSource: rule.source,
        // status stays UNCLEAR: a legacy reader must not see a green
        // tick for a rule that never applied. Setting PASS here while the
        // outcome said not_applicable was the same word-borrowing this
        // vocabulary exists to stop, one field further down.
        status: "UNCLEAR",
        outcome: "not_applicable" as const,
        method: "code_content" as const,
        ceiling: "a scan of content written through Write/Edit — it does not see content written by a shell command",
        evidence: `no file edit actually contained ${patterns.map((p) => `"${p}"`).join(" or ")} this session`,
      };
    }

    // require: absence is UNCLEAR, not a fabricated FAIL — same reasoning
    // as deterministicChecks.ts's require-polarity handling
    if (foundPattern && foundContent) {
      return {
        ruleId: rule.id,
        ruleTitle: rule.title,
        ruleSource: rule.source,
        status: "PASS",
        evidence: `found required "${foundPattern}" actually written into a file: ${foundContent.slice(0, 160)}`,
      };
    }
    return {
      ruleId: rule.id,
      ruleTitle: rule.title,
      ruleSource: rule.source,
      status: "UNCLEAR",
      evidence: `no file edit contained the required ${patterns.map((p) => `"${p}"`).join(" or ")} this session — can't tell if the rule didn't apply, or applied and was skipped`,
    };
  });
}
