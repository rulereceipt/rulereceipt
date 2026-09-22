import { loadRules } from "./rules.js";
import { classifyRules } from "./checks/classify.js";
import { runCodeContentChecks } from "./checks/codeContent.js";
import { runFileLifecycleChecks } from "./checks/fileLifecycle.js";
import { runGitBranchPolicyChecks } from "./checks/gitBranchPolicy.js";
import { runAttributionChecks } from "./checks/attribution.js";
import { loadOverrides, ruleFingerprint, ratifiedForbids } from "./overrides.js";
import { commandRunsLiteral } from "./checks/proposedAction.js";
import type { CheckResult, Rule, TranscriptEvent } from "./types.js";

interface PreToolUseInput {
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  hook_event_name?: string;
  permission_mode?: string;
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    if (process.stdin.isTTY) return resolve("");
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(""));
  });
}

interface Block {
  rule: Rule;
  why: string;
}

/**
 * The rules this can answer BEFORE the command runs.
 *
 * Deliberately only the forbidding ones. "Always run the tests before
 * committing" cannot be judged from a single proposed call — whether it was
 * already satisfied is a fact about the session, not about this command —
 * and a guard that blocked on it would fire on the first commit of every
 * session. Requirements stay with the report and the Stop hook.
 */
function forbidRules(cwd: string) {
  const overrides = loadOverrides(cwd);
  return classifyRules(loadRules(cwd)).filter((c) => {
    if (overrides.get(ruleFingerprint(c.rule))?.decision === "notARule") return false;
    return "polarity" in c && c.polarity === "forbid";
  });
}

/**
 * Runs the structured checkers against a single PROPOSED action.
 *
 * They already take a list of events and ask what it did, so a one-event
 * list describing what is about to happen is exactly the right input. This
 * is why the guard cannot drift from the report: same checkers, same
 * verdicts, different tense.
 */
function structuredBlocks(cwd: string, event: TranscriptEvent): Block[] {
  const cls = forbidRules(cwd);
  const of = (k: string) => cls.filter((c) => c.kind === k) as never;
  const results: CheckResult[] = [
    ...runCodeContentChecks(of("codeContent"), [event]),
    ...runFileLifecycleChecks(of("fileLifecycle"), [event]),
    ...runGitBranchPolicyChecks(of("gitBranchPolicy"), [event]),
    // Prevention for the attribution rule: a commit/PR carrying a
    // `Co-Authored-By: Claude` / "Generated with Claude Code" trailer is
    // refused before it is made, not just reported after. Reuses the exact
    // detection the report uses, so the two cannot disagree.
    ...runAttributionChecks(of("attribution"), [event]),
  ];
  return results
    .filter((r) => r.status === "FAIL")
    .map((r) => ({
      rule: { id: r.ruleId, title: r.ruleTitle, text: "", source: r.ruleSource } as Rule,
      why: r.evidence,
    }));
}

/**
 * A command ban blocks only where a person marked the clause.
 *
 * The unratified version was measured before shipping and cut: blocking on a
 * rule's command literals refused 62.8% of 16,336 real tool calls. Two
 * narrowings reached 2.49% and the residue had no matcher fix — a rule
 * titled "Feature Validation" refused `npm run build` 112 times, because it
 * forbids running Playwright unprompted and RECOMMENDS the build command,
 * which is its only command-shaped literal. Another refused plain
 * `git status`, its backticks holding both the ban and the alternative.
 *
 * Nothing in a rules file marks which backtick is the prohibition. So this
 * path reads only what someone declared, and yields nothing otherwise. The
 * declaration is keyed on the rule's content hash and re-checked against the
 * rule's current text, so a reworded rule loses its mark rather than
 * carrying a judgement onto words nobody read.
 *
 * The important property is what happens by default: an unmarked rule cannot
 * block, at any confidence, ever. That is the whole difference between this
 * and the version that refused two thirds of everything.
 */
function ratifiedLiteralBlocks(cwd: string, command: string): Block[] {
  const overrides = loadOverrides(cwd);
  const blocks: Block[] = [];
  // Read from the RULES, not from the classification. A human mark
  // supersedes the classifier, including its refusal to classify — and that
  // refusal is the common case here. "Never use `git push --force`; prefer
  // `git push --force-with-lease`" goes to judgment via hasMixedPolarity,
  // for a correct reason: literal matching cannot tell which half owns which
  // token. A rule naming both the ban and the alternative is the canonical
  // reason to have someone say which is which, so gating the mark behind the
  // classifier made the feature unavailable in exactly the case that
  // motivated it. Shipped that way in 0.1.39 and caught by running it.
  for (const rule of loadRules(cwd)) {
    if (overrides.get(ruleFingerprint(rule))?.decision === "notARule") continue;
    for (const literal of ratifiedForbids(overrides, rule)) {
      if (!commandRunsLiteral(command, literal)) continue;
      blocks.push({ rule, why: `the command about to run does \`${literal}\`, which this rule forbids (marked by you, not inferred)` });
      break;
    }
  }
  return blocks;
}

/**
 * Literal command bans do NOT block unless ratified. Measured, then cut.
 *
 * This was the point of the feature and it does not survive its own
 * measurement. Replaying 16,336 real tool calls against every forbidding
 * rule in the corpus, blocking on literals refused 62% of commands. Two
 * restrictions brought that to 1.6% — the literal has to be shaped like an
 * invocation rather than a noun, and the rule has to name exactly one of
 * them — and what remained was still wrong in a way no matcher can fix.
 *
 * A rule titled "Feature Validation" refused `npm run build` 112 times. It
 * forbids running Playwright without asking; it RECOMMENDS `npm run build`.
 * Forbid polarity, one command-shaped literal, and that literal is the
 * approved command. Another rule refused plain `git status`, because its
 * backticks hold both the thing it bans and the thing it suggests instead.
 *
 * Nothing in a rules file marks which backtick is the prohibition. The
 * report can live with that — it says UNCLEAR and a person reads it. A
 * blocker cannot: it would refuse the recommended command with a confident
 * explanation. So command bans stay in the report and the Stop hook, and
 * only the structured checkers, which know what kind of thing they are
 * looking at because the classifier identified a path or a branch, can
 * refuse anything here.
 *
 * The way back to command bans is an explicit opt-in — the user naming which
 * rules may block — not a cleverer guess. That is a design question for
 * whoever asks for it, not a default.
 */

function reason(blocks: Block[]): string {
  const lines = blocks.map((b) => `  • Rule ${b.rule.id} — ${b.rule.title}\n    ${b.why}`);
  const n = blocks.length;
  return (
    `RuleReceipt blocked this: it breaks ${n === 1 ? "a rule" : `${n} rules`} in CLAUDE.md.\n\n` +
    lines.join("\n\n") +
    `\n\nIf the rule should not apply here, say so to the user and let them decide. Do not work around the rule by rephrasing the command.`
  );
}

/**
 * A PreToolUse hook that refuses a command before it runs.
 *
 * The Stop hook added on 2026-09-14 catches a finished session. That is too
 * late for the case it most needs to cover: on 2026-04-25 a Cursor agent
 * running Claude Opus 4.6 deleted PocketOS's production database and every
 * volume-level backup in nine seconds, using a Railway token it found that
 * had been created for managing domains. The agent had a rule — "NEVER run
 * destructive/irreversible git commands...unless the user explicitly
 * requests them" — and afterwards quoted it back, observing that what it had
 * done was "far worse than a force push". A report would have described a
 * database that was already gone.
 *
 * What it does NOT do is the thing it was built for. Blocking on a rule's
 * banned command literal was measured before shipping and cut: see the note
 * above `reason`. It refused 62% of 16,336 real commands, and the residue
 * after two rounds of narrowing was still wrong in a way no matcher fixes.
 * PocketOS would not have been stopped by this hook, and saying otherwise
 * would be the exact failure this tool exists to catch.
 *
 * What remains is real and narrower: rules that name a FILE or a BRANCH.
 * "Never modify `.env`", "never touch `migrations/`", "never commit to
 * `main`". The classifier identified those as a path or a ref rather than
 * guessing which backtick was the prohibition, so a refusal can be stated
 * with a reason that holds up.
 *
 * Three properties, in the order they matter:
 *
 * 1. FORBIDDING rules only, answered by a structured checker. Never a
 *    judgment rule, never an LLM opinion, never a requirement, and never a
 *    bare command literal. Blocking someone's terminal on a guess is not a
 *    trade worth making at any hit rate.
 *
 * 2. It fails OPEN. Any error allows the command and writes to stderr. The
 *    opposite choice means a bug in this file stops someone from running
 *    anything at all, and they would remove the hook within the hour — which
 *    leaves them with no guard rather than an imperfect one.
 *
 * 3. It says which rule and why, in the refusal itself, because a block with
 *    no reason is indistinguishable from a broken tool.
 */
export async function runGuard(): Promise<void> {
  const allow = (): void => {
    process.stdout.write(JSON.stringify({}));
  };

  try {
    const raw = await readStdin();
    const input: PreToolUseInput = raw ? JSON.parse(raw) : {};
    const cwd = input.cwd || process.cwd();
    const tool = input.tool_name ?? "";
    const toolInput = input.tool_input ?? {};

    if (loadRules(cwd).length === 0) return allow();

    let blocks: Block[] = [];

    if (tool === "Bash" && typeof toolInput.command === "string") {
      const event: TranscriptEvent = {
        role: "assistant", kind: "tool_use", toolName: "Bash",
        input: { command: toolInput.command }, timestamp: "",
      };
      blocks = [...structuredBlocks(cwd, event), ...ratifiedLiteralBlocks(cwd, toolInput.command)];
    } else if (tool === "Write" || tool === "Edit" || tool === "NotebookEdit") {
      const event: TranscriptEvent = {
        role: "assistant", kind: "tool_use", toolName: tool,
        input: toolInput as Record<string, unknown>, timestamp: "",
      };
      blocks = structuredBlocks(cwd, event);
    } else {
      return allow();
    }

    if (blocks.length === 0) return allow();

    const why = reason(blocks);
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: why,
        },
      })
    );
    // The same reason on stderr, deliberately duplicated.
    //
    // Two refusal paths exist and they carry the message differently.
    // anthropics/claude-code#91574, measured by yurukusa on 2.1.278: a
    // top-level {"permissionDecision":"deny"} body is invoked and IGNORED;
    // the nested hookSpecificOutput form refuses; and stderr with exit 2
    // refuses. Nobody has measured the nested body together with exit 2,
    // which is what this emits.
    //
    // On the exit-2 path the documented channel back to the model is
    // stderr, and stdout JSON is not promised to be read. Writing only the
    // JSON risks a refusal with no reason attached — the block lands and
    // the model is told nothing, which is the one failure a gate cannot
    // afford. Printing both costs a duplicate line at worst.
    process.stderr.write(`${why}\n`);
    // Exit 2 is what actually blocks the call; the JSON carries the reason.
    process.exitCode = 2;
  } catch (err) {
    // Fail open, and never with exit 2 — an exit 2 from a crash would block
    // every command the session tries to run.
    process.stderr.write(`rulereceipt guard: allowing command, check did not complete (${err instanceof Error ? err.message : String(err)})\n`);
    allow();
  }
}
