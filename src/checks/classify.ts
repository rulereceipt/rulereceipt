import type { Rule } from "../types.js";

export type DeterministicPolarity = "forbid" | "require";

export interface DeterministicClassification {
  kind: "deterministic";
  rule: Rule;
  /** Literal strings pulled from the rule text (backtick-quoted) that a
   * violation would contain — e.g. a banned CLI flag, or a required one. */
  patterns: string[];
  /** "forbid": pattern found anywhere -> FAIL (the only mode that existed
   * before). "require": pattern must appear somewhere -> its ABSENCE is
   * what fails, e.g. "always run `npm test` before committing." */
  polarity: DeterministicPolarity;
}

export interface IfEditThenTestClassification {
  kind: "ifEditThenTest";
  rule: Rule;
}

export interface JudgmentClassification {
  kind: "judgment";
  rule: Rule;
}

/**
 * First real structured-check primitive (2026-08-30), replacing keyword
 * search for one whole rule category: git branch policy. A rule naming a
 * branch (e.g. "never touch the `demo` branch") was previously checked by
 * searching for the word "demo" ANYWHERE in the transcript — matching a
 * repo name, a directory, a sentence, anything. This routes instead to a
 * real parser (gitBranchPolicy.ts) that reads actual git command
 * arguments and checks the literal branch name, not a substring search.
 */
export interface GitBranchPolicyClassification {
  kind: "gitBranchPolicy";
  rule: Rule;
  branchName: string;
  polarity: DeterministicPolarity;
}

/**
 * Second structured-check primitive (2026-08-30): code content, for rules
 * naming an actual code construct — a function/method call like `print(`
 * or `analytics.track(` — rather than a CLI command. Real false-positive
 * this fixes: even after excluding tool_result (see deterministicChecks.ts),
 * a rule like "no `print(` statements" still matched when the agent's OWN
 * Bash command merely MENTIONED the pattern as an argument (e.g. grepping
 * for it), because generic deterministic matching scans the whole
 * stringified tool_use input, commands included. This routes instead to
 * codeContent.ts, which only looks at the actual content of real file
 * edits (Write/Edit/NotebookEdit) — never a Bash command string, never
 * prose, never a search argument.
 */
export interface CodeContentClassification {
  kind: "codeContent";
  rule: Rule;
  patterns: string[];
  polarity: DeterministicPolarity;
}

/**
 * Third structured-check primitive (2026-08-30): file lifecycle, for
 * rules protecting a specific file ("never modify `.claude/settings.json`",
 * "don't delete `config.yaml`"). Real false-positive this fixes: the path
 * was flagged as touched when the agent merely READ it (`cat
 * .claude/settings.json` to verify its contents) — reading a protected
 * file is not modifying it. Routes to fileLifecycle.ts, which only counts
 * real mutations: Write/Edit on that path, or a Bash rm/mv/truncate-style
 * command targeting it.
 */
export interface FileLifecycleClassification {
  kind: "fileLifecycle";
  rule: Rule;
  filePath: string;
  polarity: DeterministicPolarity;
}

/**
 * Not every line in a real CLAUDE.md is a rule. Measured against 40 real
 * public rule files (1,441 parsed items, 2026-08-30): only ~20% contained
 * any directive language at all. The other ~80% is documentation —
 * directory listings ("`forge/llm/` - Multi-provider LLM integrations"),
 * import examples, model-name tables, glob-syntax references. 521 of those
 * were getting a literal keyword check run against them, which is the
 * single largest source of false positives: checking whether a session
 * "violated" a directory listing is meaningless, and any coincidental
 * match is noise reported as a finding.
 *
 * These are reported as N/A and excluded from pass/fail entirely — not
 * sent to the LLM either, since there's no rule to judge.
 */
export interface NotARuleClassification {
  kind: "notARule";
  rule: Rule;
}

export type Classification =
  | DeterministicClassification
  | IfEditThenTestClassification
  | GitBranchPolicyClassification
  | CodeContentClassification
  | FileLifecycleClassification
  | NotARuleClassification
  | JudgmentClassification;

// Normative language — the thing that makes a line a rule rather than a
// description. Deliberately broad on modals AND imperative verbs, because
// a wrongly-excluded rule is a silent miss.
const DIRECTIVE_LANGUAGE =
  /\b(never|always|must|should|shall|do not|don't|dont|cannot|can't|required?|requires|ensure|avoid|prefer|forbidden|prohibited|only|make sure|be sure|need|needs|needed|need to|has to|have to|expected to|responsible for)\b/i;

/**
 * Imperative instruction — a bare command verb starting a clause ("Use
 * `gh pr merge`", "Run the tests first", "Keep functions small"). This is
 * the other way a real rule is written when it doesn't use a modal.
 *
 * Anchored to a clause start (line start, or after sentence/bullet
 * punctuation) on purpose: the same verbs appear mid-sentence in pure
 * documentation ("the CLI can run migrations"), where they describe a
 * capability rather than instruct the agent.
 */
const IMPERATIVE_INSTRUCTION =
  /(?:^|[.;:!?]\s+|^\s*[-*+]\s*|\n\s*[-*+]\s*)(use|run|keep|write|add|remove|delete|check|verify|test|commit|document|update|create|follow|apply|include|exclude|handle|validate|escape|sanitize|log|report|raise|throw|return|call|invoke|split|group|sort|name|place|put|store|read|load|save|close|open|start|stop|restart|install|build|deploy|review|refactor|rename|move|copy|merge|rebase|squash|tag|branch|push|pull|fetch|clone|stage|stash|lead|state|explain|describe|list|show|surface|flag|mark|label|note|treat|assume|confirm|ask|wait|stick|limit|cap|batch|cache|mock|stub|assert|expect|measure|quantify|label)\b/i;

/**
 * Deliberately inverted: tests for the presence of a DIRECTIVE, never for
 * the shape of documentation.
 *
 * The first version of this enumerated documentation shapes (backtick
 * glossary, bold-term definition, arrow mapping, label rows, "Reference:"
 * prefixes). That approach cannot work: every new rules-file convention is
 * a new shape, so the list grows forever and is always one format behind —
 * measurably so, since `notARule` coverage fell from 17.4% on a 40-file
 * sample to 7.1% on a 658-file one purely because the bigger corpus used
 * shapes the list didn't have yet.
 *
 * "Does this contain an instruction" is a bounded question about English —
 * modal verbs plus the closed class of imperative command verbs — and it
 * doesn't change when someone invents a new markdown convention. A line
 * with no instruction in it has nothing to check compliance against,
 * whatever its punctuation.
 */
/**
 * A section whose TITLE announces a record of something that happened —
 * an incident, a postmortem, a retrospective. These are written to
 * explain history, not to instruct the agent.
 *
 * Found by running this tool on a real session (2026-08-31): a section
 * titled "Real incident (2026-08-28): Vercel had the same office/personal
 * mixup" was enforced as a REQUIRE rule whose pattern was an employer
 * name pulled out of the narrative, so the report announced FOLLOWED
 * because that name appeared somewhere in the session. The rule being
 * "satisfied" was a sentence describing a past mistake.
 *
 * The existing directive test cannot catch these, and correctly so: a
 * good incident note ends with the lesson ("Verify with `vercel whoami`
 * before every deploy"), so it genuinely does contain a directive. What
 * the section IS gets announced by its title, which is where this looks.
 *
 * Kept to a small closed class of words that name a record of an event,
 * in the same spirit as DIRECTIVE_LANGUAGE above — a bounded property of
 * language, not an enumeration of document formats. Enumerating formats
 * is the mistake this project already made once and wrote up publicly.
 */
const EVENT_RECORD_TITLE = /\b(incident|post-?mortem|retro(spective)?|outage|what went wrong)\b/i;

/**
 * A title that OPENS with an instruction is a rule, whatever it goes on
 * to mention. "Never repeat the 2026-08-28 incident" is a directive that
 * happens to name an incident; "Real incident (2026-08-28): ..." is a
 * report that happens to contain the word never further along.
 */
const TITLE_OPENS_WITH_DIRECTIVE =
  /^\s*[-*+\d.\s]*(never|always|must|do not|don't|dont|avoid|ensure|prefer|only|make sure|be sure)\b/i;

function isEventRecord(rule: Rule): boolean {
  if (TITLE_OPENS_WITH_DIRECTIVE.test(rule.title)) return false;
  if (IMPERATIVE_INSTRUCTION.test(rule.title)) return false;
  return EVENT_RECORD_TITLE.test(rule.title);
}

/**
 * A line whose SUBJECT is a command-line option, i.e. the documentation of
 * a flag rather than an instruction to the agent. "`--file=<path>, -f`: Use
 * alternative tasks.json file" describes what the flag does; the imperative
 * belongs to the flag, not to the reader.
 *
 * This is why the directive test alone cannot separate these: command
 * documentation is written with the same verbs as a command, because it is
 * describing a command. The distinguishing property is grammatical — what
 * the sentence is ABOUT — and it is announced by the line beginning with an
 * option token and a separator.
 *
 * Deliberately narrow. It requires the option token to be the first thing on
 * the line and to be followed by a colon, so a rule that merely mentions a
 * flag ("Always pass `--frozen-lockfile` when installing") is untouched.
 */
const FLAG_DOCUMENTATION =
  /^\s*`?\s*-{1,2}[A-Za-z0-9][\w-]*(?:=[^\s,`]*)?(?:\s*,\s*`?\s*-{1,2}[\w-]+`?(?:=[^\s,`]*)?)*\s*`?\s*:/;

/**
 * English prose almost always contains at least one function word. A shell
 * invocation contains none, and contains at least one token carrying a path
 * separator, a flag prefix, an internal dot, or an assignment.
 *
 * Both conditions are required. "Use modular architecture" has no function
 * word either, but no command-shaped token, so it stays a rule. "Run `npm
 * test` before every push" has command-shaped tokens but also has function
 * words, so it stays a rule too.
 *
 * This is a property of the language, not of the file format — the same
 * reasoning as DIRECTIVE_LANGUAGE above, which is why it is expressed as a
 * test on the text rather than as a list of documentation conventions.
 */
const FUNCTION_WORD =
  /\b(a|an|the|is|are|was|were|be|being|been|to|of|in|on|for|with|when|if|that|this|these|those|and|or|but|not|no|do|does|you|your|it|its|as|at|by|from|before|after|until|unless|any|every|all|each|must|should|never|always|only|via|per|than|then|so|such|into|onto|over|under|about)\b/i;
const COMMAND_SHAPED_TOKEN = /(?:^|\s)(?:\S*[/\\]\S*|-{1,2}[A-Za-z]\S*|\S+\.\S+|\S+=\S+)/;

function looksLikeBareCommand(text: string): boolean {
  const withoutCode = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .trim();
  // If stripping code leaves nothing, the body WAS only code.
  const body = withoutCode.length > 0 ? withoutCode : text.replace(/[`\n]+/g, " ").trim();
  if (!body) return false;
  // Long enough to be prose, whatever it contains.
  if (body.split(/\s+/).length > 12) return false;
  if (FUNCTION_WORD.test(body)) return false;
  return COMMAND_SHAPED_TOKEN.test(body);
}

/**
 * A heading that labels a command, with the command as its whole body:
 * "Build release APK" over `.\gradlew assembleRelease`. The title reads as
 * an imperative, but nothing here constrains the agent — it is a how-to, and
 * there is no compliance to check.
 *
 * Guarded by TITLE_OPENS_WITH_DIRECTIVE so a genuine prohibition whose body
 * is the forbidden command ("Never run: `rm -rf /`") is still a rule.
 */
function isCommandDocumentation(rule: Rule): boolean {
  if (TITLE_OPENS_WITH_DIRECTIVE.test(rule.title)) return false;
  if (FLAG_DOCUMENTATION.test(rule.text) || FLAG_DOCUMENTATION.test(rule.title)) return true;
  return looksLikeBareCommand(rule.text);
}

function isNotARule(rule: Rule): boolean {
  // Checked before the directive test on purpose: an incident note that
  // ends with its lesson contains a real directive, and would otherwise
  // be enforced as though the history itself were the rule.
  if (isEventRecord(rule)) return true;
  // Same reason as above: command documentation carries real imperatives
  // ("Use alternative tasks.json file"), so the directive test below would
  // otherwise accept it as a rule to check compliance against.
  if (isCommandDocumentation(rule)) return true;
  const combined = `${rule.title} ${rule.text}`;
  if (DIRECTIVE_LANGUAGE.test(combined)) return false;
  // Title and text are tested SEPARATELY: the imperative pattern is
  // anchored to a clause start, and concatenating them pushes the text's
  // opening verb into mid-string where the anchor can never match. That
  // bug silently classified real rules ("Use `npm` for this project")
  // as non-rules — caught by an existing test, not by inspection.
  return !IMPERATIVE_INSTRUCTION.test(rule.title) && !IMPERATIVE_INSTRUCTION.test(rule.text);
}

const BRANCH_WORD = /\bbranch\b/i;

// A function/method-call shape ("print(", "analytics.track(") is a strong,
// simple signal that a backtick literal names actual CODE, not a CLI
// command or flag ("git push --force", "npm test" never look like this).
const CODE_CONSTRUCT_PATTERN = /\(/;

// A file-path shape: a known config/source extension, or a path with a
// directory separator. Deliberately requires no spaces — a real path
// literal ("`.claude/settings.json`", "`config.yaml`") never has one,
// while a command that happens to contain a slash ("`git push --force`")
// does. Checked AFTER the code-construct test, so "foo(" never lands here.
const FILE_PATH_PATTERN = /^[^\s]*(\.(json|ya?ml|toml|md|env|lock|ini|cfg|conf|xml|txt|js|ts|py|rb|go|rs|sh)$|\/)/i;

// Only route to fileLifecycle when the rule is actually about touching the
// file, not merely mentioning one (e.g. "read `config.yaml` before
// starting" names a path but isn't a protection rule).
const FILE_MUTATION_INTENT = /\b(modif|chang|edit|delet|remov|overwrit|touch|writ|creat|rename|mov)\w*\b/i;

// Catches rules like "add tests for every change" or "every new function
// needs a test" - no literal backtick token to pattern-match, so without
// this they'd fall all the way through to judgment (an LLM call) even
// though they're actually structurally checkable: did a production file
// get edited without a corresponding test file also being touched.
//
// Real false-positive found 2026-08-30 on an actual session: the earlier
// version of this heuristic (bare "test" word + any require-signal word,
// independently anywhere in the text) misclassified "Tests must be able
// to fail" - a rule about test QUALITY (a test must be demonstrated to
// fail on bad input before it counts) - as an edit-implies-test rule,
// producing nonsense like "you edited .env but no test file was touched"
// for a rule that was never about that at all. Fixed by requiring a
// specific phrase shape - a create/add/need verb close to the word
// "test" - not just independent word presence anywhere in the text.
const EDIT_IMPLIES_TEST_PHRASE = /\b(needs?\s+(a\s+)?(corresponding\s+)?test|add(?:ing|ed)?\s+tests?|write\s+tests?|include\s+tests?|corresponding\s+test|test\s+coverage\s+for)\b/i;

function isEditImpliesTestRule(rule: Rule): boolean {
  const text = `${rule.title} ${rule.text}`;
  return EDIT_IMPLIES_TEST_PHRASE.test(text);
}

const BACKTICK_TOKEN = /`([^`]+)`/g;

// Keyword signal near the rule text that this is a mandatory action, not a
// ban. Deliberately conservative: only a short, explicit set of words a
// real rule author actually uses for "you must do this" phrasing. Anything
// ambiguous defaults to "forbid" semantics (pattern found = FAIL), which
// was the only behavior that existed before this — no regression risk,
// only an additive one for rules that clearly ask for a required action.
const REQUIRE_SIGNAL = /\b(always|must|required|require|ensure|need to)\b/i;
const FORBID_SIGNAL = /\b(never|don't|do not|forbidden|banned|must not)\b/i;

/**
 * A rule can prohibit one thing AND prescribe another in the same breath:
 * "NEVER squash when merging PRs. Use `gh pr merge --merge --admin`".
 * Literal pattern matching cannot handle this — it extracts `--merge` from
 * the PRESCRIBED command, then applies the rule's forbid polarity to it,
 * so doing exactly what the rule demands gets reported as violating it.
 * Real false positive found 2026-08-30 on a real rules file.
 *
 * There's no honest way to split which literal belongs to which half by
 * pattern alone, so a mixed-polarity rule goes to judgment instead of
 * being guessed at. Better an "needs --llm" than a confident wrong FAIL.
 */
// Prescriptive language beyond the modal verbs in REQUIRE_SIGNAL. A rule
// often prescribes with a bare imperative ("Use `gh pr merge --merge`")
// rather than "you must use" — and it's exactly those imperative clauses
// whose literals get misattributed to the prohibiting half.
const PRESCRIPTIVE_VERB = /\b(use|run|prefer|apply|follow|call|invoke|stick to)\b/i;

function hasMixedPolarity(rule: Rule): boolean {
  const text = `${rule.title} ${rule.text}`;
  if (!FORBID_SIGNAL.test(text)) return false;

  // The prescription must live in a DIFFERENT clause than the prohibition.
  // "Never run `git push --force`" is one clause: "run" belongs to the
  // forbidden action, and treating that as mixed polarity would send the
  // most basic literal rule there is to the LLM. "NEVER squash when
  // merging PRs. Use `gh pr merge --merge`" is two clauses, and only the
  // second one's literals would be misattributed.
  //
  // Code spans are masked before splitting. Real bug caught by the
  // end-to-end violation tests: "Never leave a `console.log(` call in
  // committed code" was split on the period INSIDE the code span, leaving
  // a fragment ("log(` call in committed code") with no forbid word but a
  // prescriptive one, so a plain prohibition was misread as mixed
  // polarity and sent to judgment instead of being checked.
  const masked = text.replace(/`[^`]*`/g, (m) => "`" + "x".repeat(Math.max(m.length - 2, 0)) + "`");
  const clauses = masked.split(/[.;\n]|(?:\s+-\s+)/).filter((c) => c.trim().length > 0);
  return clauses.some(
    (clause) =>
      !FORBID_SIGNAL.test(clause) && (REQUIRE_SIGNAL.test(clause) || PRESCRIPTIVE_VERB.test(clause))
  );
}

function detectPolarity(rule: Rule): DeterministicPolarity {
  const text = `${rule.title} ${rule.text}`;
  // An explicit forbid word anywhere wins over a require word — "you must
  // never use X" contains both "must" and "never", and it's a ban.
  if (FORBID_SIGNAL.test(text)) return "forbid";
  if (REQUIRE_SIGNAL.test(text)) return "require";
  return "forbid";
}

/**
 * A rule is only treated as deterministic when it names a specific,
 * literal, checkable token (a CLI flag, a command, an exact string) in
 * backticks — e.g. "never use `git push --force`". Everything else
 * defaults to judgment, per the spec: never silently skip a rule by
 * guessing it's safe to pattern-match.
 */
export function classifyRule(rule: Rule): Classification {
  // Checked first: if this isn't a rule at all, no check of any kind
  // should run against it — not a keyword match, not an LLM call.
  if (isNotARule(rule)) {
    return { kind: "notARule", rule };
  }

  const patterns = new Set<string>();
  for (const match of rule.text.matchAll(BACKTICK_TOKEN)) {
    const token = match[1].trim();
    if (token.length > 0) patterns.add(token);
  }
  for (const match of rule.title.matchAll(BACKTICK_TOKEN)) {
    const token = match[1].trim();
    if (token.length > 0) patterns.add(token);
  }

  // A rule that both forbids and prescribes can't be checked by literal
  // matching without misattributing one half's tokens to the other.
  if (patterns.size > 0 && hasMixedPolarity(rule)) {
    return { kind: "judgment", rule };
  }

  if (patterns.size === 0) {
    if (isEditImpliesTestRule(rule)) {
      return { kind: "ifEditThenTest", rule };
    }
    return { kind: "judgment", rule };
  }

  const text = `${rule.title} ${rule.text}`;
  if (BRANCH_WORD.test(text)) {
    // first backtick literal is treated as the branch name — real rules
    // this targets name exactly one branch ("the `demo` branch", "never
    // push to `main`"), not a set of them
    const [branchName] = patterns;
    return { kind: "gitBranchPolicy", rule, branchName, polarity: detectPolarity(rule) };
  }

  if ([...patterns].some((p) => CODE_CONSTRUCT_PATTERN.test(p))) {
    return { kind: "codeContent", rule, patterns: [...patterns], polarity: detectPolarity(rule) };
  }

  const filePath = [...patterns].find((p) => FILE_PATH_PATTERN.test(p));
  if (filePath && FILE_MUTATION_INTENT.test(text)) {
    return { kind: "fileLifecycle", rule, filePath, polarity: detectPolarity(rule) };
  }

  return { kind: "deterministic", rule, patterns: [...patterns], polarity: detectPolarity(rule) };
}

export function classifyRules(rules: Rule[]): Classification[] {
  return rules.map(classifyRule);
}
