import { classifyRule, type DeterministicPolarity } from "./checks/classify.js";
import { ruleFingerprint } from "./overrides.js";
import type { Rule } from "./types.js";

/**
 * Rules-file health: a deterministic, pre-flight lint of the rules THEMSELVES,
 * separate from any session verdict. `audit` answers "will these rules load and
 * how much is mechanically checkable"; `rules --advise` answers "how do I make
 * one checkable"; this answers "is the set internally consistent" — the one
 * question neither of the others asks.
 *
 * The trust bar here is the same as everywhere else, and tighter: a health
 * finding is the tool criticising the user's rules file, so a false positive is
 * a false accusation with no session to blame it on. Every lint below fires only
 * on something it is CERTAIN about:
 *   - contradiction: the same distinctive literal is REQUIRED by one rule and
 *     FORBIDDEN by another, both with explicit directive language. No session can
 *     satisfy both — a genuine, unambiguous conflict.
 *   - duplicate: two rules whose normalised content is byte-identical (same
 *     fingerprint), e.g. the same rule pasted twice or copied from global into
 *     project. Noise, not a conflict — reported as a warning, never fails a gate.
 *
 * Deliberately NOT shipped yet, because neither clears the false-alarm bar
 * deterministically (see DECISIONS 2026-10-03):
 *   - "prohibition with no alternative": a forbid that names no substitute. Many
 *     legitimate prohibitions need none ("never delete the database"), and
 *     telling those apart from substitutable-tool bans ("never use `yarn`")
 *     requires an enumeration this project has been bitten by before.
 *   - "no definition of done": a quality bar with no measurable criterion. That
 *     is exactly a judgment rule, which `rules --advise` already names honestly;
 *     flagging it as a defect would nag on every valid judgment call.
 */

export type HealthFindingKind = "contradiction" | "duplicate";

export interface HealthRuleRef {
  title: string;
  source: "global" | "project";
  sourcePath?: string;
  sourceLine?: number;
}

export interface HealthFinding {
  kind: HealthFindingKind;
  /** warn = worth fixing; contradictions are the only thing `--strict` fails on. */
  severity: "warn";
  /** The literal / content at the heart of the finding, when there is one. */
  subject?: string;
  message: string;
  rules: HealthRuleRef[];
}

export interface HealthReport {
  findings: HealthFinding[];
  contradictions: number;
  duplicates: number;
  /** How many rules were examined. */
  rulesExamined: number;
}

interface Directive {
  space: "literal" | "path" | "branch";
  token: string;
  polarity: DeterministicPolarity;
  inferred: boolean;
}

/**
 * The checkable directives a rule resolves to, as (space, token, polarity).
 * Only the structured, polarity-bearing classifications contribute — judgment,
 * notARule, approvalGate, emoji, attribution and claimEvidence carry no literal
 * whose require/forbid direction could conflict with another rule's, so they are
 * never compared.
 */
function directivesOf(rule: Rule): Directive[] {
  const c = classifyRule(rule);
  switch (c.kind) {
    case "deterministic":
    case "codeContent":
      return c.patterns.map((token) => ({
        space: "literal",
        token,
        polarity: c.polarity,
        inferred: Boolean(c.polarityInferred),
      }));
    case "fileLifecycle":
      return [{ space: "path", token: c.filePath, polarity: c.polarity, inferred: Boolean(c.polarityInferred) }];
    case "gitBranchPolicy":
      return [{ space: "branch", token: c.branchName, polarity: c.polarity, inferred: Boolean(c.polarityInferred) }];
    default:
      return [];
  }
}

/**
 * Is this token distinctive enough that require-vs-forbid on it is a real
 * conflict rather than a coincidence of a common word?
 *
 * A branch name is always eligible — gitBranchPolicy has already established it
 * is a git ref, so "never push to `main`" vs "always push to `main`" is a true
 * contradiction even though "main" is a bare word. For a literal or path the
 * token must carry code punctuation (a flag, a path, a scope, a call) or be a
 * multi-token command, so a bare common word like `test` or `npm` — where the
 * opposing polarities usually describe different actions on the same noun, not a
 * conflict — is never compared.
 */
function isDistinctive(space: Directive["space"], token: string): boolean {
  if (space === "branch") return true;
  if (/\s/.test(token)) return true;
  return /[.\-/@#:()]/.test(token);
}

function refOf(rule: Rule): HealthRuleRef {
  return { title: rule.title, source: rule.source, sourcePath: rule.sourcePath, sourceLine: rule.sourceLine };
}

/** A stable per-occurrence key, so the same physical rule is never compared to itself. */
function occurrenceKey(rule: Rule): string {
  return `${rule.source}\u0000${rule.sourcePath ?? ""}\u0000${rule.sourceLine ?? ""}\u0000${rule.id}`;
}

function dedupeRefs(rules: Rule[]): HealthRuleRef[] {
  const seen = new Set<string>();
  const out: HealthRuleRef[] = [];
  for (const r of rules) {
    const k = occurrenceKey(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(refOf(r));
  }
  return out;
}

/**
 * Same distinctive literal required by one rule and forbidden by another.
 *
 * Only EXPLICIT polarities are compared (a bare imperative like "Use `npm`"
 * whose direction was inferred is excluded), so an inferred requirement never
 * manufactures a conflict with a real prohibition. Conditionally-scoped forbids
 * ("never run `terraform apply` on main") are already routed to judgment by the
 * classifier and so never reach here.
 */
export function findContradictions(rules: Rule[]): HealthFinding[] {
  const buckets = new Map<string, { require: Rule[]; forbid: Rule[] }>();
  for (const rule of rules) {
    for (const d of directivesOf(rule)) {
      if (d.inferred) continue;
      if (!isDistinctive(d.space, d.token)) continue;
      const key = `${d.space}\u0000${d.token.trim().toLowerCase()}`;
      let b = buckets.get(key);
      if (!b) {
        b = { require: [], forbid: [] };
        buckets.set(key, b);
      }
      b[d.polarity].push(rule);
    }
  }

  const findings: HealthFinding[] = [];
  for (const [key, b] of buckets) {
    if (b.require.length === 0 || b.forbid.length === 0) continue;
    // A single rule carries one polarity, so require/forbid lists are disjoint;
    // still, require at least one occurrence on each side to be a distinct rule.
    const requireRefs = dedupeRefs(b.require);
    const forbidRefs = dedupeRefs(b.forbid);
    if (requireRefs.length === 0 || forbidRefs.length === 0) continue;
    const token = key.slice(key.indexOf("\u0000") + 1);
    findings.push({
      kind: "contradiction",
      severity: "warn",
      subject: token,
      message: `\`${token}\` is required by one rule and forbidden by another — no session can satisfy both. Decide which wins and drop or scope the other.`,
      rules: [...forbidRefs, ...requireRefs],
    });
  }
  return findings;
}

/** Two or more rules with byte-identical normalised content. */
export function findDuplicates(rules: Rule[]): HealthFinding[] {
  const groups = new Map<string, Rule[]>();
  for (const rule of rules) {
    const fp = ruleFingerprint(rule);
    const g = groups.get(fp);
    if (g) g.push(rule);
    else groups.set(fp, [rule]);
  }

  const findings: HealthFinding[] = [];
  for (const group of groups.values()) {
    const refs = dedupeRefs(group);
    if (refs.length < 2) continue;
    const title = group[0].title.replace(/\s+/g, " ").trim().slice(0, 60);
    findings.push({
      kind: "duplicate",
      severity: "warn",
      subject: title,
      message: `"${title}" appears ${refs.length} times with identical wording — keep one copy so a verdict is not reported twice for the same rule.`,
      rules: refs,
    });
  }
  return findings;
}

export function runHealth(rules: Rule[]): HealthReport {
  const contradictions = findContradictions(rules);
  const duplicates = findDuplicates(rules);
  return {
    findings: [...contradictions, ...duplicates],
    contradictions: contradictions.length,
    duplicates: duplicates.length,
    rulesExamined: rules.length,
  };
}

/** Where a rule lives, for the render — `file:line` when known, else the title. */
function whereRef(r: HealthRuleRef): string {
  const scope = r.source === "global" ? " (global)" : "";
  if (r.sourcePath) return `${r.sourcePath}${r.sourceLine ? `:${r.sourceLine}` : ""}${scope}`;
  return `"${r.title.replace(/\s+/g, " ").trim().slice(0, 60)}"${scope}`;
}

/**
 * A short, readable health report. Advisory by design (the caller exits 0
 * unless asked to be strict): it comments on the rules file, so it leads with
 * "nothing wrong" when clean and never overstates.
 */
export function renderHealth(report: HealthReport, md = false): string {
  const H = (s: string) => (md ? `## ${s}` : s);
  const out: string[] = [];
  out.push(md ? "# RuleReceipt — rules health" : "RuleReceipt · rules health  (no session needed)");
  out.push("");
  if (report.findings.length === 0) {
    out.push(`No contradictions or duplicate rules found across ${report.rulesExamined} rule${report.rulesExamined === 1 ? "" : "s"}.`);
    out.push("");
    out.push("This checks the rules against each other (do two rules conflict, is one pasted twice).");
    out.push("For load/precedence/checkability, run:  rulereceipt audit");
    return out.join("\n");
  }

  if (report.contradictions > 0) {
    out.push(H(`Contradictions (${report.contradictions})`));
    for (const f of report.findings.filter((x) => x.kind === "contradiction")) {
      out.push(`  !  ${f.message}`);
      for (const r of f.rules) out.push(`       - ${whereRef(r)}`);
    }
    out.push("");
  }
  if (report.duplicates > 0) {
    out.push(H(`Duplicate rules (${report.duplicates})`));
    for (const f of report.findings.filter((x) => x.kind === "duplicate")) {
      out.push(`  !  ${f.message}`);
      for (const r of f.rules) out.push(`       - ${whereRef(r)}`);
    }
    out.push("");
  }
  out.push("These are advisory. For load/precedence/checkability, run:  rulereceipt audit");
  return out.join("\n");
}
