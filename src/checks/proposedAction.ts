import { withoutHeredocs } from "./shellCommand.js";
import { canonicalise, matchesPattern } from "./deterministicChecks.js";

/**
 * Commands that read. A banned literal appearing as an argument to one of
 * these is being searched for, printed, or paged — not run.
 *
 * This is the whole reason the post-hoc deterministic checker refuses to
 * report a violation: a text match cannot tell an action from a mention.
 * Before the tool runs, most of that ambiguity is gone — the command IS the
 * action — but not all of it, because a command can still quote a literal
 * while doing something harmless with it. This list is what is left of the
 * problem, and it is deliberately a known list: anything not on it is
 * treated as doing something.
 *
 * `sed` is absent on purpose. `sed -i` edits in place; plain `sed` does not,
 * and the difference is handled below rather than by listing the name.
 */
const READ_ONLY = new Set([
  "grep", "rg", "ag", "ack", "egrep", "fgrep",
  "echo", "printf", "cat", "bat", "head", "tail", "less", "more",
  "find", "fd", "ls", "wc", "sort", "uniq", "diff", "comm",
  "awk", "jq", "yq", "cut", "tr", "column", "tee",
  "which", "type", "file", "stat", "man", "help",
]);

/** Read-only git subcommands — `git log` cannot delete anything. */
const READ_ONLY_GIT = new Set(["log", "show", "diff", "status", "blame", "describe", "config", "remote", "branch", "tag", "ls-files", "rev-parse", "shortlog"]);

/**
 * Splits a shell command into the pieces that run separately.
 *
 * Crude by design: this is not a shell parser and must never pretend to be
 * one. It exists so that `grep "rm -rf" notes.txt && npm run build` is read
 * as two things, one of which searches for a string and one of which does
 * not, rather than as one blob containing a banned literal.
 */
function segments(command: string): string[] {
  return withoutHeredocs(command)
    .split(/\n|&&|\|\||[;|]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** The executable a segment invokes, with env assignments and `sudo` skipped. */
function leadingCommand(segment: string): string {
  const words = segment.split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) || words[i] === "sudo" || words[i] === "command" || words[i] === "time")) i++;
  const exe = (words[i] ?? "").replace(/^.*\//, "");
  return exe;
}

/**
 * A commit message is text the user wrote, not a command being run.
 *
 * Real case in this project's own history: a commit message containing
 * backticked shell examples. A message that quotes a banned command in order
 * to describe it must not be treated as running it.
 */
function withoutCommitMessage(segment: string): string {
  return segment.replace(/(-m|--message)(=|\s+)(['"])(?:\\.|(?!\3)[\s\S])*\3/g, "$1 <message>");
}

/**
 * Does this segment actually DO the forbidden thing?
 *
 * Returns false for a segment that only reads, searches, or prints.
 */
function segmentRunsLiteral(segment: string, literal: string): boolean {
  const exe = leadingCommand(segment);
  if (READ_ONLY.has(exe)) return false;
  if (exe === "sed" && !/\s-[A-Za-z]*i\b/.test(segment)) return false;
  if (exe === "git") {
    const sub = segment.split(/\s+/).filter(Boolean)[1] ?? "";
    // A read-only git subcommand cannot be the destructive act — unless the
    // rule names that subcommand itself, which is a real thing people write
    // ("never run `git config user.email`"), so the literal still has to be
    // checked against it. What is skipped is only the case where the literal
    // is some OTHER command quoted inside a read-only one.
    if (READ_ONLY_GIT.has(sub) && !literal.includes(`git ${sub}`)) return false;
  }
  return matchesPattern(canonicalise(withoutCommitMessage(segment)), literal);
}

/**
 * Is this literal shaped like a command, rather than a noun?
 *
 * The single most important restriction in the guard, and it exists because
 * the first version was measured before it shipped. Replaying 16,322 real
 * tool calls against the 371 literal prohibitions in the corpus, it refused
 * 62% of them. The literals doing the damage were ordinary words that rules
 * name in passing — `browse`, `mix`, `index.ts`, `scripts:`, `AGENTS.md` —
 * each of which appears in perfectly innocent commands all day.
 *
 * A prohibition worth blocking on names an invocation: `git push --force`,
 * `rm -rf`, `npm publish`, or a bare flag like `--no-verify`. So: it must
 * contain whitespace, or begin with a dash. A single bare word is never
 * enough, which does mean a rule that says only "never use `rm`" is not
 * enforced here. That is the right way round. The report still carries it,
 * and refusing to run someone's command on the strength of one ambiguous
 * word is not a trade worth making.
 */
export function literalIsCommandShaped(literal: string): boolean {
  const t = literal.trim();
  if (t.length === 0) return false;
  if (/^-{1,2}[A-Za-z]/.test(t)) return true;
  // Must BEGIN like a command too, not merely contain a space: `, and` is a
  // real corpus literal and it blocked 118 commands on its own.
  if (!/^[A-Za-z][A-Za-z0-9_.\/-]*(\s|$)/.test(t)) return false;
  return /\s/.test(t);
}

/**
 * Whether a command that is ABOUT TO RUN performs the forbidden thing.
 *
 * The post-hoc checker cannot answer this and says so: a literal in a
 * transcript may be a violation, a grep, or an explanation, and nothing in
 * the string distinguishes them. Before execution the question is narrower
 * and mostly answerable, because the command is the act. What remains is
 * separating the parts of a compound command that do something from the
 * parts that only look at something, which is what this does.
 */
export function commandRunsLiteral(command: string, literal: string): boolean {
  if (!literalIsCommandShaped(literal)) return false;
  return segments(command).some((s) => segmentRunsLiteral(s, literal));
}
