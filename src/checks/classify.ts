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
  /\b(never|always|must|should|shall|do not|don't|dont|cannot|can't|required?|requires|ensure|avoid|prefer|forbidden|prohibited|only|make sure|be sure|need to|has to|have to|expected to)\b/i;

// A glossary/listing shape: a backtick-quoted token followed by a dash and
// a description ("`forge/llm/` - Multi-provider LLM integrations"). This is
// documentation structure, not a directive, and it's the single most common
// non-rule shape in the real corpus.
const GLOSSARY_ENTRY = /^\s*`[^`]+`\s*[-–—:]/;

/**
 * Conservative on purpose: only excludes an item when it has NO directive
 * language anywhere AND looks structurally like documentation. A rule
 * wrongly excluded is a silent missed check; a doc line wrongly included is
 * a loud false positive. Given the real-world failure mode found on
 * 2026-08-30 was 10/10 false positives, the bias is set toward excluding
 * documentation — but only where both signals agree.
 */
function isNotARule(rule: Rule): boolean {
  const text = `${rule.title} ${rule.text}`;
  if (DIRECTIVE_LANGUAGE.test(text)) return false;
  return GLOSSARY_ENTRY.test(rule.title) || GLOSSARY_ENTRY.test(rule.text);
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
