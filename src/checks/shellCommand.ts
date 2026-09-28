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
    // A heredoc opener: `<<WORD`, `<<-WORD`, `<<'WORD'`, `<<"WORD"`, and the
    // backslash-escaped `<<\WORD` (valid POSIX, same "no expansion" effect as
    // quoting). All spellings must strip the body, or a command that WRITES a
    // command is misread as one that RUNS it.
    const open = line.match(/<<-?\s*(?:'([^']+)'|"([^"]+)"|\\([A-Za-z_][A-Za-z0-9_]*)|([A-Za-z_][A-Za-z0-9_]*))/);
    if (open) {
      const delimiter = open[1] ?? open[2] ?? open[3] ?? open[4] ?? null;
      const at = open.index ?? 0;
      const before = line.slice(0, at);
      const afterDelim = line.slice(at + open[0].length);
      // Only a REAL opener starts a body. `echo "see <<EOF"` merely mentions
      // one — treating it as an opener silently deletes every following line,
      // which hid real later commands from every caller. A genuine opener is
      // not inside an already-open quote, and is followed only by an optional
      // redirect/target (`<<EOF > out.txt`), never by more words.
      if (delimiter !== null && isHeredocOpener(before, afterDelim)) {
        closing = delimiter;
        out.push(line.slice(0, at));
        continue;
      }
    }
    out.push(line);
  }
  return out.join("\n");
}

/**
 * Is a matched `<<WORD` an actual heredoc opener, given the text before it and
 * the text after the delimiter token? Rejects a `<<WORD` sitting inside an
 * already-open quote (it is data), and one followed by more command words
 * (also not a real opener).
 */
function isHeredocOpener(before: string, afterDelim: string): boolean {
  const singles = (before.match(/'/g) ?? []).length;
  const doubles = (before.match(/"/g) ?? []).length;
  if (singles % 2 === 1 || doubles % 2 === 1) return false;
  return /^\s*(?:[0-9]*>>?\s*[^\s<>|;&]+\s*)?$/.test(afterDelim);
}

/**
 * Splits a shell command into the pieces that run separately.
 *
 * Crude by design — not a shell parser. Heredoc bodies are stripped first, so
 * a command that only WRITES another command is not split into it. Shared by
 * every checker that needs to reason about what a compound command actually
 * runs (proposedAction, attribution).
 */
export function segments(command: string): string[] {
  return withoutHeredocs(command)
    .split(/\n|&&|\|\||[;|]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** The executable a segment invokes, with env assignments and `sudo` skipped. */
export function leadingCommand(segment: string): string {
  const words = segment.split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) || words[i] === "sudo" || words[i] === "command" || words[i] === "time")) i++;
  return (words[i] ?? "").replace(/^.*\//, "");
}

/**
 * Blanks out a git/gh commit or PR MESSAGE, leaving the command around it.
 *
 * A `-m "…"` / `--message "…"` value is text the author wrote, not a command
 * being run, and not a path being touched — a message that quotes `rm …` or
 * names a protected file must not be read as doing either. Shared so every
 * checker that scans a Bash command string strips it the same way (this was
 * present only in proposedAction, so fileLifecycle and testCommands each
 * false-matched on commit-message text — findings 2026-09-26).
 */
export function withoutCommitMessage(command: string): string {
  return command.replace(/(-m|--message)(=|\s+)(['"])(?:\\.|(?!\3)[\s\S])*\3/g, "$1 <message>");
}

/**
 * Blanks out quoted-string CONTENTS and drops #-comments, so a command MENTION
 * inside a quote or a comment is not read as the command running.
 *
 * Found 2026-09-28: `echo "git push"` and `cat notes.md # git push` were both
 * flagged as an unapproved push, because the matcher saw "git push" anywhere in
 * the string. Blanking quote contents keeps the real verb visible (`git commit
 * -m "msg"` still reads as a commit) while removing the mention. Use this only
 * where a MENTION must not count as an action; checks that need the quoted text
 * (attribution's commit-message trailer) must not use it.
 */
export function withoutQuotedMentions(command: string): string {
  const noQuotes = command.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
  // A `#` that begins a word (start or after whitespace) starts a comment.
  return noQuotes.replace(/(^|\s)#[^\n]*/g, "$1");
}
