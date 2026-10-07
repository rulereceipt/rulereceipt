/**
 * Remove terminal control sequences from text that came from an untrusted
 * transcript before it is printed. A session file can contain ANSI/OSC escapes —
 * colour codes, cursor moves, and especially OSC 8 hyperlinks (`ESC ] 8 ; ; url
 * ESC \`) — and printing them raw lets a crafted session spoof RuleReceipt's own
 * output or rewrite the terminal. We strip them from DISPLAY text only (never
 * from the text the checks match on), so a verdict is unchanged but what reaches
 * the terminal is inert.
 *
 * Added 2026-10-07 (pre-launch security pass). Keeps ordinary whitespace (\n, \t);
 * removes ESC-introduced sequences (CSI/OSC/other) and the other C0/C1 control
 * characters, including a bare BEL and backspace.
 */
// Order matters: match CSI (`ESC [ … `), OSC (`ESC ] … BEL/ST`) and string
// sequences (`ESC P/^/_ … ST`) BEFORE the generic two-char Fe escape, so a full
// sequence is removed rather than just its `ESC`. The generic class lists @, A-Z,
// `\`, ^, _ explicitly (NOT `[` or `]`, which the specific alts handle).
const ANSI = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001B]*(?:\u0007|\u001B\\)|[P^_][^\u001B]*\u001B\\|[@A-Z\\^_])/g;
// C0 controls except \t (09) \n (0A) \r (0D); plus DEL (7F) and C1 (80-9F).
const OTHER_CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

export function stripTerminalEscapes(text: string): string {
  if (!text || (!text.includes("\u001B") && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/.test(text))) {
    return text; // fast path: nothing to strip
  }
  return text.replace(ANSI, "").replace(OTHER_CONTROLS, "");
}
