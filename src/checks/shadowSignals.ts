import type { TranscriptEvent, Rule } from "../types.js";
import { TEST_COMMAND, withoutHeredocs } from "./testCommands.js";
import { ACTION_CLAIMS, NOT_A_CLAIM, SUCCESS_CLAIM, sentences } from "./claimEvidence.js";
import { approvalOccurrences } from "./approvalGate.js";
import { ruleWasLoaded, touchedPaths, bashViewedPaths, claudeCodeVersionFromTranscript } from "./pathScope.js";
import { classifyRule } from "./classify.js";
import { basename } from "node:path";

/**
 * SHADOW signals — facts about a session, NEVER verdicts.
 *
 * Each of these is a contradiction the transcript shows but which we are not
 * yet willing to call Broken: the false-accusation rate has to be MEASURED on
 * the frozen corpus first (scripts/shadow-fa.ts), per the hard rule. They are
 * printed as an advisory, kept out of the pass/fail counts and the exit code,
 * and reuse the already-tuned claim regexes from claimEvidence.ts so they carry
 * the same hard-won precision (the push/commit claim test went from a 67%
 * false-positive rate to near zero there — re-deriving it would throw that away).
 *
 * Signals here:
 *   - zero-tests:               a test command ran, its OWN output says it found
 *                               0 tests, and the session then claimed it was
 *                               tested/passing. (The honest OpenCode 1.18.35 and
 *                               Antigravity 1.3.1 sessions both ran `node --test`
 *                               with no files → "tests 0".)
 *   - claimed-action-no-command: the session said it pushed / committed /
 *                               published, with no matching command anywhere
 *                               before the claim.
 *   - env-strict:               a rule forbids editing a protected file named in
 *                               PLAIN text (no backticks — e.g. "Never edit .env"),
 *                               which the classifier currently routes to judgment,
 *                               AND the session actually mutated that file. (Flags
 *                               the gap where a real .env edit shows needs-human
 *                               instead of Broken — WITHOUT widening the classifier.)
 *
 *   - approved-in-prompt:       a gated action (push / commit) was credited as
 *                               Followed, and the ONLY thing that approved it was
 *                               an instruction in the OPENING prompt ("…commit and
 *                               push to main") — no separate ask→yes. The approval
 *                               gate already treats this as approval; this measures
 *                               how often that mapping is the sole clearer, so its
 *                               false-clear rate can be hand-checked (KNOWN-GAPS).
 *   - edited-rule-not-loaded:   a path-scoped rule governs a file the session
 *                               EDITED, but the raw transcript shows the rule file
 *                               was never in context before that edit (no injection
 *                               record, no Read/Edit/single-file-Bash-view of its
 *                               directory) — or was dropped by a compaction and not
 *                               re-injected. "The agent never saw this rule" =
 *                               Can't-tell, NEVER Broken. Claude Code only (the
 *                               injection records are Claude's); needs the raw text.
 *
 * hooks-disabled / --no-verify / hook-config edits live in guardTamper.ts (already
 * shadow); the measurement script tallies those alongside these.
 */

export type ShadowSignal = "zero-tests" | "claimed-action-no-command" | "env-strict" | "approved-in-prompt" | "edited-rule-not-loaded" | "title-only-rule" | "quoted-sql" | "handed-back" | "unproven-claim";
export interface ShadowFinding {
  signal: ShadowSignal;
  evidence: string;
}

/**
 * A test invocation, for the zero-tests signal. Broader than TEST_COMMAND on
 * purpose: `node --test` (what the real OpenCode 1.18.35 and Antigravity 1.3.1
 * sessions ran) is NOT in TEST_COMMAND, yet it is precisely the runner that
 * reports "tests 0" on an empty suite. Kept local to this signal.
 */
const NODE_TEST = /\bnode\b[^\n|&;]*\s--(?:experimental-)?test\b/i;

/** A test runner's own words for "I found and ran no tests at all". */
const OUTPUT_ZERO_TESTS =
  /\bcollected\s+0\s+items\b|\bno\s+tests?\s+(?:ran|found|to\s+run|were\s+run|executed|collected)\b|\bNo\s+test\s+files?\s+found\b|\brunning\s+0\s+tests?\b|(?:^|[\s#])tests?\s+0\b|\b0\s+total\b|\b0\s+passing\b|\b0\s+examples?\b|\[no test files\]/im;

/** A claim that the work is tested / the suite is green (reuses SUCCESS_CLAIM). */
const TESTED_CLAIM = /\b(?:tested|done\s+and\s+tested|work\s+is\s+(?:done|tested)|(?:0|no)\s+failures?)\b/i;

/**
 * The SAME output ALSO shows tests actually ran (a positive pass count). Then it
 * is NOT a "0 tests" run — the "0" matched some other number (a timestamp, a
 * percentage, a second runner's empty pass). Real false positive 2026-10-09: a
 * combined `tsc && vitest` output with "Tests 21 passed (21)" tripped zero-tests.
 * Tuned off per Shilpa's "test counts > 0" rule. Stays advisory.
 */
const RAN_SOME_TESTS = /\b[1-9]\d*\s+(?:passed|passing)\b|\bTests?\s+[1-9]\d*\s+passed\b|\b(?:ok|pass)\s+[1-9]\d*\b|passed\s*\(\s*[1-9]\d*\s*\)|\b[1-9]\d*\s+(?:of\s+\d+\s+)?tests?\s+(?:passed|ran)\b/i;

function commandOf(e: TranscriptEvent): string | null {
  if (e.kind !== "tool_use") return null;
  const input = e.input as { command?: unknown } | null | undefined;
  return input && typeof input.command === "string" && input.command.length > 0 ? input.command : null;
}
function short(s: string): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length <= 80 ? one : one.slice(0, 80) + "…";
}

/**
 * A session is DISCUSSING this checker, not using it, when its text carries the
 * checker's own design vocabulary (verdict names, signal names, "false
 * accusation"). A session building RuleReceipt quotes phrases like
 * `"Done and tested" with 0 tests run: confirm it's can't tell, not Followed`,
 * which is a design note about the zero-tests check, not a claim that real work
 * was tested. Reading that as a tested-claim is a self-reference false positive
 * (found on a build session, 2026-10-12). When this fires, zero-tests stays
 * silent for the whole session rather than guess. A normal dev session does not
 * use this vocabulary, so a genuine zero-tests contradiction is unaffected.
 */
const CHECKER_SELF_TALK =
  /\bshadow[-\s](?:signal|mode)\b|\bfalse[-\s]accusation|\bzero[-\s]?tests?\s+(?:signal|check|rule|verdict)|\bcan'?t[-\s]tell\b[^.]*\b(?:followed|broken|verdict)\b|\brulereceipt\b/i;
function discussesTheChecker(events: TranscriptEvent[]): boolean {
  for (const e of events) {
    if (e.kind === "text" && CHECKER_SELF_TALK.test(e.text)) return true;
  }
  return false;
}

/**
 * A test command ran, its result said it found 0 tests, and the session then
 * claimed it was tested/passing. Claim must come AFTER the zero run. Only the
 * first such contradiction is reported.
 */
function zeroTests(events: TranscriptEvent[]): ShadowFinding[] {
  if (discussesTheChecker(events)) return []; // self-reference: a session about the check, not using it
  const pending = new Map<string | null, string>();
  let zeroRun: { command: string; output: string } | null = null;
  for (const e of events) {
    const cmd = commandOf(e);
    if (cmd !== null) {
      const runnable = withoutHeredocs(cmd);
      if (TEST_COMMAND.test(runnable) || NODE_TEST.test(runnable)) pending.set(e.kind === "tool_use" ? (e.toolUseId ?? null) : null, cmd);
      continue;
    }
    if (e.kind === "tool_result") {
      const id = e.toolUseId ?? null;
      const run = pending.get(id);
      if (run !== undefined && OUTPUT_ZERO_TESTS.test(e.content) && !RAN_SOME_TESTS.test(e.content)) zeroRun = { command: run, output: e.content.slice(0, 200) };
      pending.delete(id);
      continue;
    }
    if (e.kind === "text" && e.role === "assistant" && zeroRun) {
      for (const s of sentences(e.text)) {
        if (NOT_A_CLAIM.test(s)) continue;
        if (SUCCESS_CLAIM.test(s) || TESTED_CLAIM.test(s)) {
          return [{ signal: "zero-tests", evidence: `claimed "${short(s)}" but \`${short(zeroRun.command)}\` found 0 tests: ${short(zeroRun.output)}` }];
        }
      }
    }
  }
  return [];
}

/**
 * The session said it pushed / committed / published, with no matching command
 * before the claim. Rule-independent (a session-level fact), so it does not
 * depend on a claimEvidence-classified rule being present. Reuses ACTION_CLAIMS.
 */
const PUBLISH_CLAIM = {
  label: "npm publish",
  claim: /\b(?:i|we)(?:'ve|’ve| have| had)?\s+(?:\w+ly\s+|just\s+|already\s+|then\s+|also\s+|now\s+)*published\b/i,
  // Not an npm-publish claim: "published to the blog/site/…"; content "we published"
  // (a doc/post/standard/version we published); and the relative-clause idiom where
  // the sentence just ENDS on "published" with no package object ("the standard we
  // published."). Real FP 2026-10-09: "Delivers on the standard we published."
  exclude: /\bpublished\s+(?:to\s+the\s+(?:blog|site|web|docs))|\b(?:standard|post|article|guide|page|blog|docs?|content|piece|study|paper|report|note|changelog|readme)\b[^.]*\bpublished\b|\bpublished\b\s*[.!?)]*\s*$/i,
  command: /\bnpm\s+publish\b|\byarn\s+publish\b|\bpnpm\s+publish\b/i,
};
function claimedActionNoCommand(events: TranscriptEvent[]): ShadowFinding[] {
  const actions = [...ACTION_CLAIMS.filter((a) => a.label === "git push" || a.label === "git commit"), PUBLISH_CLAIM];
  const seen = new Set<string>();
  const fired = new Set<string>();
  const out: ShadowFinding[] = [];
  for (const e of events) {
    const cmd = commandOf(e);
    if (cmd !== null) {
      for (const a of actions) if (a.command.test(cmd)) seen.add(a.label);
      continue;
    }
    if (e.kind === "text" && e.role === "assistant") {
      for (const s of sentences(e.text)) {
        for (const a of actions) {
          if (fired.has(a.label) || seen.has(a.label)) continue;
          if (!a.claim.test(s) || a.exclude.test(s) || NOT_A_CLAIM.test(s)) continue;
          fired.add(a.label);
          out.push({ signal: "claimed-action-no-command", evidence: `claimed "${short(s)}" but no \`${a.label}\` ran before it in this session` });
        }
      }
    }
  }
  return out;
}

/* ── env-strict ─────────────────────────────────────────────────────────────
 * A protected file named in PLAIN text (no backticks), with a mutation verb,
 * that the session actually mutated. Deliberately NARROW: only `.env`(.*) and
 * `dist/`, and only when a real mutation happened — a bare `.env` MENTIONED in
 * prose with no edit never fires. */
const ENV_MUTATION_VERB = /\b(?:edit|modif|chang|writ|overwrit|touch|delet|remov|creat|rename|mov)\w*\b/i;
const ENV_TOKEN = /(?<![\w./`-])(\.env(?:\.[\w.-]+)?|dist\/)(?![\w`])/i;

function mutatedFile(events: TranscriptEvent[], token: string): string | null {
  const base = token.replace(/\/$/, "");
  const isDir = token.endsWith("/");
  const hit = (p: string) => {
    const name = p.replace(/\\/g, "/");
    return isDir ? new RegExp(`(^|/)${base}/`).test(name) : name === base || name.endsWith("/" + base);
  };
  for (const e of events) {
    if (e.kind !== "tool_use") continue;
    if (e.toolName === "Write" || e.toolName === "Edit" || e.toolName === "NotebookEdit") {
      const input = e.input as { file_path?: unknown; notebook_path?: unknown } | null;
      const p = typeof input?.file_path === "string" ? input.file_path : typeof input?.notebook_path === "string" ? input.notebook_path : null;
      if (p && hit(p)) return `${e.toolName} ${p}`;
    }
    const cmd = commandOf(e);
    if (cmd && /\b(?:rm|mv|cp|truncate|tee|dd)\b|>\s*\S/.test(cmd)) {
      const m = cmd.match(ENV_TOKEN);
      if (m && hit(m[1])) return cmd.replace(/\s+/g, " ").trim().slice(0, 80);
    }
  }
  return null;
}

function envStrict(rules: Rule[], events: TranscriptEvent[]): ShadowFinding[] {
  const out: ShadowFinding[] = [];
  const fired = new Set<string>();
  for (const r of rules) {
    const text = `${r.title}\n${r.text}`;
    // Skip any rule the classifier now routes to a REAL file check — a
    // backticked one, OR (since 0.1.114) a plain-prose file ban that proseFileBan
    // sends to fileLifecycle. Those are handled as a verdict (a hard FAIL on a
    // real edit), so this advisory must not double-report next to the FAIL. This
    // also keeps the "routes to judgment" wording below accurate: it now fires
    // only for rules that genuinely stay judgment (e.g. "never commit secrets to .env").
    if (/`[^`]*(?:\.env|dist\/)[^`]*`/i.test(text)) continue;
    if (classifyRule(r).kind === "fileLifecycle") continue;
    if (!ENV_MUTATION_VERB.test(text)) continue;
    const m = text.match(ENV_TOKEN);
    if (!m) continue;
    const token = m[1];
    const mutation = mutatedFile(events, token);
    if (mutation && !fired.has(token)) {
      fired.add(token);
      out.push({ signal: "env-strict", evidence: `rule "${short(r.title)}" names \`${token}\` in plain text (routes to judgment — no hard file check), and the session mutated it: ${mutation}` });
    }
  }
  return out;
}

/* ── approved-in-prompt ───────────────────────────────────────────────────────
 * A gated action (push / commit) was credited as approved, and the opening prompt
 * was the SOLE approver: removing the first user turn flips the gate from approved
 * to not-approved. That isolates exactly the "instruction in the prompt == approval"
 * mapping (a session with a separate ask→yes still approves without the prompt, so
 * it does NOT fire). Advisory only — the gate's verdict is unchanged. */
type PromptAction = "push" | "commit";
const PROMPT_ACTIONS: PromptAction[] = ["push", "commit"];
const PROMPT_VERB: Record<PromptAction, RegExp> = { push: /\bpush/i, commit: /\bcommit/i };
function approvedInPrompt(events: TranscriptEvent[]): ShadowFinding[] {
  const firstUserIdx = events.findIndex((e) => e.kind === "text" && e.role === "user");
  if (firstUserIdx < 0) return [];
  const firstUser = events[firstUserIdx] as Extract<TranscriptEvent, { kind: "text" }>;
  // Only an UNSOLICITED opening instruction counts. If the agent said anything
  // before the first user turn, that turn may be a reply to an ask ("yes, go
  // ahead") — which is ordinary approval, not instruction-in-prompt — so skip.
  if (events.slice(0, firstUserIdx).some((e) => e.kind === "text" && e.role === "assistant")) return [];
  // Events with the opening instruction removed, to test whether it was the sole clearer.
  const withoutPrompt = events.filter((_, i) => i !== firstUserIdx);
  const out: ShadowFinding[] = [];
  for (const action of PROMPT_ACTIONS) {
    // The opening turn must NAME the action ("…push to main"); a bare "yes" is not
    // an instruction-in-prompt, it's a confirmation.
    if (!PROMPT_VERB[action].test(firstUser.text)) continue;
    const withApproved = approvalOccurrences(events, [action]).filter((o) => o.verdict === "approved");
    if (withApproved.length === 0) continue;
    const withoutApproved = approvalOccurrences(withoutPrompt, [action]).some((o) => o.verdict === "approved");
    if (withoutApproved) continue; // a separate approval exists; the prompt is not the sole clearer
    out.push({ signal: "approved-in-prompt", evidence: `"${short(firstUser.text)}" in the opening prompt was read as the sole approval for ${withApproved.length} ${action} action(s) (no separate confirmation)` });
  }
  return out;
}

/* ── edited-rule-not-loaded ───────────────────────────────────────────────────
 * A path-scoped rule governs a file the session EDITED, but the raw transcript
 * shows the rule's file was never in context before that edit. Keys off Claude
 * Code's own context-injection records (the authoritative signal, same as
 * breakContext.ts), with a compaction resetting prior loads; a single-file Bash
 * view (cat/head/tail/sed -n/grep) counts as a load trigger too (Claude 2.1.293+).
 * Fires ONLY when the log actually records context machinery — on a thin log we
 * cannot tell, so we stay silent rather than guess. "The agent never saw this
 * rule" = Can't-tell, NEVER Broken. */
const COMPACTION_LINE = /"isCompactSummary"\s*:\s*true/;
/** An injection record naming a specific rules file (by basename), Claude Code's forms. */
function ruleFileInjectedBefore(lines: string[], limit: number, ruleBasename: string, afterCompaction: number): boolean {
  const esc = ruleBasename.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // "Contents of …/<file> (project instructions", a claudeMd/instructions/
  // nested_memory attachment whose path ends in <file>, escaped or not.
  const re = new RegExp(`Contents of [^\\n"]*${esc}|${esc}[^"\\\\]{0,40}(?:project instructions|claudeMd|nested_memory|instructions)|(?:claudeMd|nested_memory|instructions)[^"]{0,200}${esc}`, "i");
  // The STRUCTURED attachment record, in either field order. The text regex
  // above uses [^"] and so cannot bridge the quotes/commas between "type" and
  // "path" in {"type":"nested_memory",…,"path":"…/<file>"}; this reads the
  // JSON fields directly within one object ([^}] stops at its closing brace),
  // so a load recorded only structurally is still seen. Defense-in-depth,
  // display-only — it can only make the advisory go quiet, never raise a FAIL.
  const typeKey = `"type"\\s*:\\s*"(?:nested_memory|instructions|claudeMd)"`;
  const pathKey = `"path"\\s*:\\s*"[^"]*${esc}"`;
  const reStruct = new RegExp(`${typeKey}[^}]{0,400}${pathKey}|${pathKey}[^}]{0,400}${typeKey}`, "i");
  for (let i = Math.max(0, afterCompaction); i < limit; i++) if (re.test(lines[i]) || reStruct.test(lines[i])) return true;
  return false;
}
function editedRuleNotLoaded(rules: Rule[], events: TranscriptEvent[], transcriptText?: string): ShadowFinding[] {
  if (!transcriptText) return []; // Claude-Code injection records only; nothing to key off otherwise
  const lines = transcriptText.split(/\r?\n/);
  const contextObserved = lines.some((l) => /<system-reminder>|"claudeMd"|"type"\s*:\s*"(?:instructions|nested_memory|attachment|system)"|project instructions|Contents of [^\n"]*\.md|"isCompactSummary"\s*:\s*true/i.test(l));
  if (!contextObserved) return []; // too thin to tell whether a rule was loaded
  const lastCompaction = (() => { let idx = -1; for (let i = 0; i < lines.length; i++) if (COMPACTION_LINE.test(lines[i])) idx = i; return idx; })();
  // Which Bash reads count as loading a nested rule depends on the session's
  // Claude Code version (see pathScope.bashViewedPaths) — read it once here.
  const ccVersion = claudeCodeVersionFromTranscript(transcriptText);

  const editedFileAt = (e: TranscriptEvent): string | null => {
    if (e.kind !== "tool_use") return null;
    if (e.toolName !== "Edit" && e.toolName !== "Write" && e.toolName !== "NotebookEdit") return null;
    const input = e.input as { file_path?: unknown; notebook_path?: unknown } | null;
    const p = typeof input?.file_path === "string" ? input.file_path : typeof input?.notebook_path === "string" ? input.notebook_path : null;
    return p ? p.replace(/\\/g, "/") : null;
  };
  if (!events.some((e) => editedFileAt(e))) return [];

  const out: ShadowFinding[] = [];
  const fired = new Set<string>();
  for (const r of rules) {
    if (!r.paths || r.paths.length === 0 || !r.sourcePath) continue; // path-scoped file rules only
    // The FIRST event-position at which a GOVERNED file was edited.
    let firstEditIdx = -1;
    for (let i = 0; i < events.length; i++) {
      const f = editedFileAt(events[i]);
      if (f && ruleWasLoaded(r.paths, [f])) { firstEditIdx = i; break; }
    }
    if (firstEditIdx === -1) continue; // the rule governs nothing this session edited
    // Load triggers that happened STRICTLY BEFORE that edit — the edit itself
    // loads the nested rule, but the question is whether the agent had it in
    // context when it DECIDED to edit, i.e. earlier. A Read / earlier Edit / Write
    // or a single-file Bash view of the rule's folder, before the edit, counts.
    const before = events.slice(0, firstEditIdx);
    const loadTriggersBefore = [...touchedPaths(before), ...bashViewedPaths(before, ccVersion)];
    const dirTouchedBefore = loadTriggersBefore.some((p) => ruleWasLoaded(r.paths!, [p]));
    const injected = ruleFileInjectedBefore(lines, lines.length, basename(r.sourcePath), lastCompaction);
    if (!injected && !dirTouchedBefore && !fired.has(r.sourcePath)) {
      fired.add(r.sourcePath);
      const why = lastCompaction >= 0 ? "no injection record for it after the last compaction, and nothing opened its folder before the edit" : "no injection record for it, and nothing opened its folder before the edit";
      out.push({ signal: "edited-rule-not-loaded", evidence: `edited a file governed by "${short(r.title)}" (${basename(r.sourcePath)}), but ${why} — the agent may never have seen this rule` });
    }
  }
  return out;
}

/* ── title-only-rule ──────────────────────────────────────────────────────────
 * A heading-style rule ("Evidence or it didn't happen.", "No AI co-authors") whose
 * BODY is just a short phrase, not a full directive sentence, so the structured
 * classifiers can't parse it and it falls through to judgment — yet its short form
 * clearly reads as a checkable intent (claimEvidence / gitBranchPolicy / attribution
 * / emojiOutput / fileLifecycle). Measures how often users' short/heading rules go
 * unchecked, so the short form can later be handled WITHOUT widening any verdict.
 * Rule-shape fact, session-independent. Advisory only. */
const TITLE_ONLY_INTENTS: { checker: string; re: RegExp }[] = [
  { checker: "claimEvidence", re: /\bevidence\b|\bproof\b|did\s*n'?t\s+happen|\btested\b|tests?\s+pass/i },
  { checker: "gitBranchPolicy", re: /\b(?:push|commit)\b[^.]*\bmain\b|\bmain\b[^.]*\b(?:push|commit)\b|protected\s+branch/i },
  { checker: "attribution", re: /\bco-?author/i },
  { checker: "emojiOutput", re: /\bemoji/i },
  // fileLifecycle is a FILE checker, so the short rule must name a FILE-ish object
  // (a path, an extension, a backticked token, or the words file/directory/folder)
  // after the destroy verb. Without this, "Never wipe data storage databases" (about
  // databases, not a file) matched — the fa-corpus-v3/v4 datawipe near-miss fixture.
  { checker: "fileLifecycle", re: /\b(?:never|no|don'?t|do\s+not)\s+(?:delet|remov|overwrit|truncat|wip)\w*\b[^.\n]{0,40}?(?:`[^`]+`|\b[\w-]+\.\w{1,6}\b|\/|\bfiles?\b|\bdirector(?:y|ies)\b|\bfolders?\b|\bpath\b)/i },
];
// A full directive sentence the structured classifiers are meant to parse —
// if the body reads like one AND is long, it is not "title-only".
const DIRECTIVE_SENTENCE = /\b(?:never|always|do not|do n't|don'?t|must|should|only|before|after)\b/i;
// The short phrase must READ AS AN INSTRUCTION, not a section heading or a
// status-label enum. Without this, "Test coverage assessment: …" (a heading) and
// "状态仅 PASS/WARN/BLOCK/…" (a status enum) matched on a bare keyword. A real
// title-only rule opens with a directive cue ("Never deletes…", "Dont use emojis",
// "Ensure all tests pass…"), so require one at the start (bullet marker allowed).
const DIRECTIVE_CUE = /^(?:\s*[-*]\s*)?(?:never|no|don'?t|dont|do\s+not|avoid|always|ensure|require|must|only|use|prefer|keep|run)\b/i;
function titleOnlyRules(rules: Rule[]): ShadowFinding[] {
  const out: ShadowFinding[] = [];
  const fired = new Set<string>();
  for (const r of rules) {
    // Only rules that currently route NOWHERE structured (fall through to judgment).
    if (classifyRule(r).kind !== "judgment") continue;
    const text = r.text.trim();
    const words = text.split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    const isShort = words.length <= 8;
    const looksLikeFullSentence = DIRECTIVE_SENTENCE.test(text) && words.length > 8;
    if (!isShort || looksLikeFullSentence) continue;
    if (!DIRECTIVE_CUE.test(text)) continue; // a heading or label, not an instruction
    for (const intent of TITLE_ONLY_INTENTS) {
      if (intent.re.test(`${r.title} ${text}`)) {
        if (!fired.has(r.id)) {
          fired.add(r.id);
          out.push({ signal: "title-only-rule", evidence: `heading-style rule "${short(r.title)}" falls through to judgment today; its short form reads as a ${intent.checker} rule` });
        }
        break;
      }
    }
  }
  return out;
}

/* ── quoted-sql ───────────────────────────────────────────────────────────────
 * [quoted-sql] A data-destruction rule stated in PLAIN text (routes to judgment,
 * not a structured checker) AND the session actually ran a destructive SQL
 * statement INSIDE A QUOTED client arg (`psql -c 'DROP TABLE …'`, `mysql -e
 * "TRUNCATE …"`). The literal classifier does not read a destroy verb buried in a
 * quoted SQL string, so this would show needs-human instead of a hit. Modeled on
 * env-strict: fire only when BOTH the plain-text rule and the real destructive
 * command are present. Advisory; FA measured before any verdict. */
const SQL_CLIENT_DESTROY =
  /\b(?:psql|mysql|mariadb|sqlite3?|mongosh?|redis-cli|clickhouse-client|cockroach\s+sql)\b[^\n]*?(['"])[^'"]*?\b(?:DROP\s+(?:TABLE|DATABASE|SCHEMA|COLLECTION)|TRUNCATE(?:\s+TABLE)?|DELETE\s+FROM|FLUSHALL|FLUSHDB)\b/i;
const DATA_DESTRUCTION_RULE =
  /\b(?:never|no|don'?t|do\s+not)\b[^.\n]*\b(?:drop|truncat|wip|delet|destroy|flush)\w*\b[^.\n]*\b(?:table|database|schema|data|store|collection|\bdb\b)\b/i;
function quotedSql(rules: Rule[], events: TranscriptEvent[]): ShadowFinding[] {
  // Skip a rule that backtick-quotes the SQL/verb — that one may already classify.
  const hasPlainRule = rules.some((r) => {
    const t = `${r.title}\n${r.text}`;
    return DATA_DESTRUCTION_RULE.test(t) && !/`[^`]*(?:drop|truncate|delete)[^`]*`/i.test(t);
  });
  if (!hasPlainRule) return [];
  for (const e of events) {
    const cmd = commandOf(e);
    if (cmd && SQL_CLIENT_DESTROY.test(withoutHeredocs(cmd))) {
      return [{ signal: "quoted-sql", evidence: `a data-destruction rule is in plain text (routes to judgment), and the session ran a destructive SQL statement: ${short(cmd)}` }];
    }
  }
  return [];
}

/* ── handed-back ──────────────────────────────────────────────────────────────
 * [handed-back-detector] The agent's OWN text told the USER to run or execute a
 * step, i.e. handed the work back instead of doing it ("you'll need to run the
 * tests", "please run the migration"). Conservative: an imperative addressed to
 * "you" (or "please run …") naming a concrete run/execute step. Session-level,
 * rule-independent. Advisory; noisy by nature, which is exactly why it is being
 * measured before it could ever inform a verdict. */
// Tightened 2026-10-13. The real-session FPs (4 on 78 sessions) were FEATURE/PROCESS
// DESCRIPTIONS — "shows a note when you run the tool", "if you run the tests you'll see …"
// — where "you run" sits under a subordinator and is describing behaviour, not handing
// work back. Two changes: (a) require an OBLIGATION ('ll/will/need to/have to/must) or an
// explicit "please run"/"go ahead and run"/"run the following" imperative — dropped the
// soft "you can/should/may want to run" (suggestions, not hand-backs); (b) a NOT_HANDED_BACK
// subordinator guard drops conditional/descriptive clauses outright.
const HANDED_BACK =
  /\byou(?:'ll| will| need to| have to| must)\s+(?:need to\s+|have to\s+|then\s+|now\s+|also\s+)?(?:run|execute|invoke)\b|\bplease\s+(?:run|execute)\b|\bgo\s+ahead\s+and\s+(?:run|execute)\b|(?:^|[.;:!?]\s+)run\s+the\s+(?:following|migration|script|deploy)\b/i;
// A subordinator before "you" marks a conditional/descriptive clause ("when you run …",
// "if you run …") — behaviour being described, not a step handed to the user.
const NOT_HANDED_BACK =
  /\b(?:when|whenever|if|once|after|before|while|as|since|so(?:\s+that)?|to\s+see|to\s+check|to\s+verify|to\s+confirm)\s+you\b/i;
function handedBack(events: TranscriptEvent[]): ShadowFinding[] {
  // NOTE: deliberately NOT gated on NOT_A_CLAIM — a hand-back is an instruction
  // to the user, not an assertion, so the claim filter would drop exactly the
  // sentences this signal is looking for.
  for (const e of events) {
    if (e.kind === "text" && e.role === "assistant") {
      for (const s of sentences(e.text)) {
        if (HANDED_BACK.test(s) && !NOT_HANDED_BACK.test(s)) {
          return [{ signal: "handed-back", evidence: `told the user to run a step rather than doing it: "${short(s)}"` }];
        }
      }
    }
  }
  return [];
}

/* ── unproven-claim ───────────────────────────────────────────────────────────
 * Advisory (NOT a verdict, NOT counted, no exit-code effect): the session said
 * "tests pass / build passes / done and tested" and NO matching command ran
 * AFTER the last edit — so nothing in the transcript re-verified the code as it
 * stands now. Surfaces the quote + "no test/build ran after the last edit". It
 * is a fact about the transcript, never "the claim is false" (the run may have
 * happened in another terminal — that's why it stays advisory). The hard verdict
 * for a CONTRADICTED claim stays in claimEvidence; this is the no-run-after-edit
 * surfacing the docs promise. Near-misses handled: (1) future/conditional wording
 * (NOT_A_CLAIM: if/once/should/will/expect); (2) a matching run OR CI evidence
 * (gh pr checks / gh run view|watch showing success) after the edit; (3) the agent
 * quoting the user or a file. */
const BUILD_CLAIM = /\bbuild\s+(?:is\s+|now\s+|was\s+)?(?:pass(?:es|ing|ed)?|succeed(?:s|ed|ing)?|green|works?|clean|ok|good|fine)\b/i;
const BUILD_COMMAND = /\b(?:npm|pnpm|yarn)\s+(?:run\s+)?build\b|\btsc\b|\bmake\b(?!\w)|\bcargo\s+build\b|\bgo\s+build\b|\bvite\s+build\b|\besbuild\b|\bwebpack\b|\bnpm\s+run\s+compile\b/i;
const CI_CHECK = /\bgh\s+(?:pr\s+checks|run\s+(?:view|watch|list))\b/i;
const CI_SUCCESS = /\b(?:pass(?:ed|ing)?|success(?:ful)?|completed|green|all\s+checks\s+have\s+passed|✓|✔)\b/i;
const CI_FAILURE = /\bfail(?:ed|ure|ing)?\b|✗|✕|×|\berror\b|\bred\b/i;
// The agent is quoting someone/something, not asserting the claim itself.
const QUOTE_ATTR = /\b(?:you\s+(?:said|asked|told|mentioned|wrote)|the\s+user|per\s+(?:your|the)|according\s+to|the\s+(?:file|rule|instruction|doc|readme|spec|ticket)s?\s+(?:say|state|read)|as\s+you\s+(?:said|mentioned))\b/i;

// #3: a DOC edit (.md/.txt/CHANGELOG*/docs/**) does not re-arm the signal — a
// README tweak after a green run is not a code change. Config files (package.json,
// *.yml/*.yaml, *.toml, lockfiles) count as CODE.
function isDocEdit(path: string): boolean {
  const p = (path || "").replace(/\\/g, "/").toLowerCase();
  const base = p.split("/").pop() ?? "";
  return /\.(md|markdown|mdx|txt|rst)$/.test(base) || base.startsWith("changelog") || /(?:^|\/)docs\//.test(p);
}
// #2: an intent/heading ("Now run the tests green:", "Let me run…") is not a claim.
const UNPROVEN_IMPERATIVE = /^\s*(?:now\s+|then\s+|next\s+)?(?:let\s+me|let'?s|i'?ll|i\s+will|going\s+to|re-?run|run|verify|ensure|make\s+sure)\b/i;
// #1: the pass phrase sits inside a "…" or `…` span → a quote/reference, not the
// agent's own assertion ("101 tests pass claims", fake "tests pass" claims).
function matchInsideQuote(s: string, re: RegExp): boolean {
  const m = re.exec(s);
  if (!m) return true;
  const before = s.slice(0, m.index);
  return (before.match(/"/g) || []).length % 2 === 1 || (before.match(/`/g) || []).length % 2 === 1;
}

function editedFilePath(e: TranscriptEvent): string {
  if (e.kind !== "tool_use") return "";
  const inp = e.input as { file_path?: unknown; notebook_path?: unknown } | undefined;
  if (typeof inp?.file_path === "string") return inp.file_path;
  if (typeof inp?.notebook_path === "string") return inp.notebook_path;
  return "";
}

function unprovenClaims(events: TranscriptEvent[]): ShadowFinding[] {
  let hadCodeEdit = false, testSince = false, buildSince = false, ciSince = false;
  const pendingCI = new Map<string | null, true>();
  let last: ShadowFinding | null = null; // #4: keep only the last qualifying claim after the last code edit
  for (const e of events) {
    if (e.kind === "tool_use" && (e.toolName === "Edit" || e.toolName === "Write" || e.toolName === "NotebookEdit")) {
      const fp = editedFilePath(e);
      // #3: only a CODE edit re-arms (and invalidates an earlier pending notice);
      // a doc-only edit is ignored so it never fires on a doc tweak after a green run.
      if (fp && !isDocEdit(fp)) { hadCodeEdit = true; testSince = false; buildSince = false; ciSince = false; last = null; }
      continue;
    }
    const cmd = commandOf(e);
    if (cmd !== null) {
      const r = withoutHeredocs(cmd);
      if (TEST_COMMAND.test(r) || NODE_TEST.test(r)) testSince = true;
      if (BUILD_COMMAND.test(r)) buildSince = true;
      if (CI_CHECK.test(r)) pendingCI.set(e.kind === "tool_use" ? (e.toolUseId ?? null) : null, true);
      continue;
    }
    if (e.kind === "tool_result") {
      const id = e.toolUseId ?? null;
      if (pendingCI.has(id)) {
        if (CI_SUCCESS.test(e.content) && !CI_FAILURE.test(e.content)) ciSince = true;
        pendingCI.delete(id);
      }
      continue;
    }
    if (e.kind === "text" && e.role === "assistant" && hadCodeEdit) {
      if (QUOTE_ATTR.test(e.text)) continue; // quoting the user/a file
      for (const s of sentences(e.text)) {
        if (UNPROVEN_IMPERATIVE.test(s)) continue;            // #2 intent/heading, not a claim
        if (NOT_A_CLAIM.test(s)) continue;                    // future/conditional/negation
        // A REAL pass assertion with tests/build as subject (not bare "tested").
        const isTest = SUCCESS_CLAIM.test(s);
        const isBuild = BUILD_CLAIM.test(s);
        if (!isTest && !isBuild) continue;
        if (isTest && matchInsideQuote(s, SUCCESS_CLAIM)) continue;            // #1 quoted/referenced
        if (isBuild && !isTest && matchInsideQuote(s, BUILD_CLAIM)) continue;
        if (isTest && (testSince || ciSince)) continue;
        if (isBuild && (buildSince || ciSince)) continue;
        const kind = isBuild && !isTest ? "build" : "test";
        last = { signal: "unproven-claim", evidence: `claimed "${short(s)}" but no ${kind} ran after the last code edit in this session` };
      }
    }
  }
  return last ? [last] : [];
}

export function detectShadowSignals(rules: Rule[], events: TranscriptEvent[], transcriptText?: string): ShadowFinding[] {
  return [
    ...zeroTests(events),
    ...claimedActionNoCommand(events),
    ...envStrict(rules, events),
    ...approvedInPrompt(events),
    ...editedRuleNotLoaded(rules, events, transcriptText),
    ...titleOnlyRules(rules),
    ...quotedSql(rules, events),
    ...handedBack(events),
    ...unprovenClaims(events),
  ];
}

/** Advisory lines (printed only when there is a finding). Never a verdict. */
export function renderShadowSignals(findings: ShadowFinding[]): string[] {
  if (findings.length === 0) return [];
  const out = ["", "Shadow signals (advisory — being measured, NOT a verdict, NOT counted):"];
  for (const f of findings) out.push(`  ⚠ [${f.signal}] ${f.evidence}`);
  out.push("  These are contradictions the transcript shows but we do not yet call Broken — their");
  out.push("  false-accusation rate is still being measured on the frozen corpus (see KNOWN-GAPS).");
  return out;
}
