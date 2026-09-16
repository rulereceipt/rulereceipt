import { loadRules } from "./rules.js";
import { readTranscriptFromFile } from "./parsers/transcriptParser.js";
import { evaluateSession } from "./evaluate.js";
import type { CheckResult, Rule } from "./types.js";

/**
 * The subset of the Stop hook payload this needs. Everything else Claude
 * Code sends is ignored on purpose — a hook that reads more of the payload
 * than it uses breaks on the next field they add.
 */
interface StopHookInput {
  transcript_path?: string;
  cwd?: string;
  stop_hook_active?: boolean;
  hook_event_name?: string;
}

/** Claude Code's Stop-hook response. Absent `decision` means "let it stop". */
interface StopHookOutput {
  decision?: "block";
  reason?: string;
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

/**
 * What Claude is told when it tries to finish on a broken rule.
 *
 * Addressed to the model, not to the person: it is the model that has to
 * act on this, and a message written for a human reader ("see the report
 * above") gives it nothing to do. Names the rule, states what was found,
 * and stops — no instruction to "fix it", because the rule already said
 * what to do and repeating it invites the model to argue with the wording
 * instead of going and running the thing.
 */
function blockReason(failures: CheckResult[], unverified: CheckResult[]): string {
  const parts: string[] = [];

  if (failures.length > 0) {
    const n = failures.length;
    parts.push(
      `RuleReceipt: ${n} rule${n === 1 ? "" : "s"} in CLAUDE.md ${n === 1 ? "was" : "were"} not followed in this session.\n\n` +
        failures.map((f) => `  • Rule ${f.ruleId} — ${f.ruleTitle}\n    ${f.evidence}`).join("\n\n")
    );
  }

  // Worded as a question about evidence rather than as a finding, because
  // that is what it is. Nothing here says the claim is false. It says
  // nothing in this session shows it to be true, and that the difference
  // belongs to the user rather than to the summary.
  if (unverified.length > 0) {
    parts.push(
      `RuleReceipt: this session claims work is done, and nothing recorded here verifies it.\n\n` +
        unverified.map((u) => `  • Rule ${u.ruleId} — ${u.ruleTitle}\n    ${u.evidence}`).join("\n\n") +
        `\n\nThis is not a claim that you are wrong. It may well have been verified somewhere this transcript cannot see.`
    );
  }

  parts.push(
    `Do not report this work as finished until the above is resolved, or you have said plainly, to the user, ` +
      `what was actually verified and what was not.`
  );
  return parts.join("\n\n");
}

/**
 * A Stop hook that refuses to let a session end on a broken rule.
 *
 * The gap this closes was named by a reader of anthropics/claude-code#90542
 * on 2026-09-14, from a lab that measured it: a receiving agent auto-ACKed
 * 107 dispatched orders and did none of them, and 69 of 664 records marked
 * complete were plans rather than completions. Their conclusion — "rules
 * that live only in context are advisory by construction; rules that live
 * in a gate are not" — applies to this tool as it stood, which read the
 * transcript afterwards and told you what had already happened.
 *
 * Three safety properties, in the order they matter:
 *
 * 1. FAIL only. Never UNCLEAR, never NOT_RUN, never a judgment rule, and
 *    never the LLM path — a model opinion is an opinion, and blocking on
 *    one would let a wrong guess hold a session hostage. This gate fires
 *    only on the deterministic checkers, where the finding is a matched
 *    literal and can be read back.
 *
 * 2. It cannot loop. Claude Code sets `stop_hook_active` when the session
 *    is already continuing because of a previous block. Blocking again
 *    there is how a Stop hook wedges a session permanently, so this returns
 *    immediately in that case: it gets exactly one interruption per stop.
 *
 * 3. It fails OPEN. Any error — unreadable transcript, no rules file,
 *    malformed payload — allows the stop and writes a line to stderr.
 *    Failing closed is the right default for money-touching code; here it
 *    would mean a bug in this tool leaves someone unable to end a session
 *    in their own editor, and they would rip the hook out that day. The
 *    cost of the two failures is not symmetric, so the default is not
 *    symmetric either. It is a deliberate weakening, and it is the reason
 *    `check` in CI stays the backstop rather than this.
 */
export async function runHook(needsLlmResult: (rule: Rule) => CheckResult): Promise<void> {
  const emit = (out: StopHookOutput): void => {
    process.stdout.write(JSON.stringify(out));
  };

  try {
    const raw = await readStdin();
    const input: StopHookInput = raw ? JSON.parse(raw) : {};

    // Property 2: one interruption per stop.
    if (input.stop_hook_active) return void emit({});

    const cwd = input.cwd || process.cwd();
    if (!input.transcript_path) return void emit({});

    const rules = loadRules(cwd);
    if (rules.length === 0) return void emit({});

    const events = readTranscriptFromFile(input.transcript_path);
    // An empty transcript produces no failures, which would read as a pass.
    // Nothing to gate on, so allow — and say nothing, because a hook that
    // warns on every empty read is a hook people mute.
    if (events.length === 0) return void emit({});

    // Property 1: deterministic only. `llm: false` is not a default here,
    // it is part of the contract.
    const { results } = await evaluateSession(cwd, rules, events, false, needsLlmResult);
    const failures = results.filter((r) => r.status === "FAIL" && r.outcome !== "not_run");
    // Deliberately NOT a FAIL. See CheckResult.unverifiedClaim: the report
    // calls this unclear and the gate refuses it, and that is the only place
    // the two are allowed to disagree.
    const unverified = results.filter((r) => r.unverifiedClaim === true);

    if (failures.length === 0 && unverified.length === 0) return void emit({});
    return void emit({ decision: "block", reason: blockReason(failures, unverified) });
  } catch (err) {
    // Property 3: fail open, but never silently.
    process.stderr.write(`rulereceipt hook: allowing stop, check did not complete (${err instanceof Error ? err.message : String(err)})\n`);
    return void emit({});
  }
}
