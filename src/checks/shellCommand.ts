/**
 * Facts about shell command text that more than one checker needs.
 *
 * Created 2026-09-15. The heredoc guard below lived in testCommands.ts, was
 * used only by the test-command matcher, and the file-mutation checker never
 * saw it — so the same class of false accusation was fixed in one reader and
 * left standing in the other. Anything that reasons about what a shell
 * command DID, rather than what it says, belongs here.
 */
/**
 * Removes heredoc bodies from a shell command.
 *
 * A command that WRITES a test command is not a command that RUNS one.
 * Found 2026-09-14 on a real session: two false failures whose "last test
 * run" was a shell variable assignment. The actual match came from a
 * heredoc further down, writing a demo fixture whose body contains the
 * string `npm test`. The literal was being generated, never executed — and
 * the tool then read its own report output as the failing result.
 *
 * Handles both quoted and bare delimiters, and leaves everything after the
 * closing delimiter intact, because a real test run often follows the
 * heredoc that set the fixture up.
 */
export function withoutHeredocs(command: string): string {
  const lines = command.split("\n");
  const out: string[] = [];
  let closing: string | null = null;
  for (const line of lines) {
    if (closing !== null) {
      if (line.trim() === closing) closing = null;
      continue;
    }
    const open = line.match(/<<-?\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/);
    if (open) {
      closing = open[1] ?? open[2] ?? open[3];
      out.push(line.slice(0, open.index));
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}
