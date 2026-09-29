import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { parseClaudeMd } from "./parsers/readClaudeMd.js";
import { findClaudeHomeDirNames } from "./parsers/transcriptParser.js";
import { loadMemoryRules } from "./parsers/readMemory.js";
import { resolveImports } from "./parsers/imports.js";
import type { Rule } from "./types.js";

/**
 * Every place Claude Code actually reads a rule from, at one directory
 * level. Order mirrors the documented load order, broadest first.
 *
 * Real gap found 2026-09-02: only the two bare filenames were read. A
 * project with four rules files reported "1 rules checked · all passed" —
 * three files invisible, with nothing saying so. A clean report on rules
 * the tool never opened is the most misleading result this can produce,
 * worse than no report, because it looks like evidence.
 */
const RULE_DIRS = [join(".claude", "rules")];

/**
 * Lists the rule-doc files in a directory, if it exists.
 *
 * Sorted so the same project always produces the same rule order — rule
 * ids are positional, and an unstable order would renumber rules between
 * runs on different machines, making two reports of the same session
 * impossible to compare. Only the given extensions count: a rules
 * directory legitimately holds README fragments and notes. `.mdc` is
 * Cursor's rule-file extension (Markdown + a YAML frontmatter block, which
 * the reader strips).
 */
function markdownFilesIn(dir: string, exts: string[] = [".md"]): string[] {
  if (!existsSync(dir)) return [];
  try {
    if (!statSync(dir).isDirectory()) return [];
    return readdirSync(dir)
      .filter((f) => exts.some((e) => f.toLowerCase().endsWith(e)))
      .sort()
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

/**
 * One candidate rules file, and whether the agent would actually load it.
 *
 * `loaded` files are what the tool checks a session against. `shadowed` files
 * exist on disk but the agent ignores them (a CLAUDE.md at the same level wins
 * over AGENTS.md; the modern .cursor/rules directory supersedes .cursorrules; a
 * manual/model_decision .agents/rules file is not auto-loaded). Checking a
 * session against a shadowed file would be a false accusation, so they are
 * discovered but never fed to the checker — the load graph reports them so the
 * "why isn't my rule firing?" question has an honest answer.
 */
export type RuleSourceStatus = "loaded" | "shadowed";
export interface RuleSource {
  /** Absolute path on disk. */
  path: string;
  status: RuleSourceStatus;
  /** Human label for the format/convention, e.g. "Claude (CLAUDE.md)". */
  format: string;
  /** Why a shadowed file is ignored; undefined for loaded files. */
  note?: string;
}

/**
 * Every candidate rules file at one directory level, in documented load order,
 * each tagged loaded or shadowed. This is the single source of truth for both
 * what gets checked (`ruleFilesAtLevel`, the loaded subset) and the load graph
 * (`describeRuleSources`) — so the report can never claim a file was loaded
 * that the checker skipped, or vice versa.
 */
function ruleSourcesAtLevel(dir: string): RuleSource[] {
  const out: RuleSource[] = [];
  const has = (rel: string) => existsSync(join(dir, rel));
  const loaded = (rel: string, format: string) => {
    if (has(rel)) out.push({ path: join(dir, rel), status: "loaded", format });
  };
  const shadowed = (rel: string, format: string, note: string) => {
    if (has(rel)) out.push({ path: join(dir, rel), status: "shadowed", format, note });
  };

  // CLAUDE.md shadows AGENTS.md at the same level: as of 2026-09-19 Claude
  // Code loads AGENTS.md ONLY when that level has no CLAUDE.md, and silently
  // ignores it otherwise. `init` separately WARNS about the shadowed file (see
  // shadowedAgents.ts). Mirrored for the `.claude/` subdir pair.
  if (has(join(".claude", "CLAUDE.md"))) {
    loaded(join(".claude", "CLAUDE.md"), "Claude (.claude/CLAUDE.md)");
    shadowed(join(".claude", "AGENTS.md"), "AGENTS (.claude/AGENTS.md)", "a CLAUDE.md at the same level wins");
  } else {
    loaded(join(".claude", "AGENTS.md"), "AGENTS (.claude/AGENTS.md)");
  }

  for (const rel of RULE_DIRS) {
    for (const f of markdownFilesIn(join(dir, rel))) out.push({ path: f, status: "loaded", format: ".claude/rules" });
  }

  if (has("CLAUDE.md")) {
    loaded("CLAUDE.md", "Claude (CLAUDE.md)");
    // AGENTS.md (and the singular AGENT.md some tools use) are ignored when
    // there's a CLAUDE.md at this level, mirroring Claude Code's shadow rule.
    shadowed("AGENTS.md", "AGENTS.md", "a CLAUDE.md at the same level wins");
    shadowed("AGENT.md", "AGENT.md", "a CLAUDE.md at the same level wins");
  } else {
    loaded("AGENTS.md", "AGENTS.md");
    loaded("AGENT.md", "AGENT.md");
  }
  // .local variants: precedence relative to the base files is not documented,
  // so both are kept rather than guessing at a shadow rule.
  loaded("CLAUDE.local.md", "Claude (CLAUDE.local.md)");
  loaded("AGENTS.local.md", "AGENTS (AGENTS.local.md)");

  // Non-Claude rule-file conventions (added 2026-09-26 for multi-tool
  // support), read IN ADDITION to Claude's files when present. The engine
  // (classify.ts) is agent-neutral. Precedence is FIXED so rule ids stay
  // deterministic: Claude family (above), then Cursor, Copilot, Windsurf.
  //
  // Cursor: the modern `.cursor/rules/*.mdc|.md` directory SHADOWS the legacy
  // single `.cursorrules` file — Cursor deprecated `.cursorrules` in favour of
  // the directory, so reading both would double-count.
  const cursorRules = markdownFilesIn(join(dir, ".cursor", "rules"), [".mdc", ".md"]);
  if (cursorRules.length > 0) {
    for (const f of cursorRules) out.push({ path: f, status: "loaded", format: "Cursor (.cursor/rules)" });
    shadowed(".cursorrules", "Cursor (.cursorrules)", "the .cursor/rules/ directory supersedes the legacy file");
  } else {
    loaded(".cursorrules", "Cursor (.cursorrules)");
  }

  // GitHub Copilot: repo-level custom instructions.
  loaded(join(".github", "copilot-instructions.md"), "Copilot");

  // Windsurf (Codeium): single rules file.
  loaded(".windsurfrules", "Windsurf");

  // Google's newer agent convention / "agents rules": .agents/rules/*.md, each
  // with a `trigger:` frontmatter block. The trigger decides whether the agent
  // auto-loads the file, so it decides whether we may check against it:
  //   - always_on / glob (or no trigger)  → loaded, checked
  //   - manual / model_decision           → not auto-loaded → shadowed
  // README fragments in the directory are notes, not rules, so they are skipped
  // entirely (not even reported — they were never a candidate rule).
  for (const file of markdownFilesIn(join(dir, ".agents", "rules"), [".md"])) {
    if (/(^|[/\\])readme\.md$/i.test(file)) continue;
    let head = "";
    try {
      head = readFileSync(file, "utf-8").slice(0, 600);
    } catch {
      continue;
    }
    if (/^---[\s\S]*?^\s*trigger:\s*(?:manual|model_decision)\b/m.test(head)) {
      out.push({ path: file, status: "shadowed", format: ".agents/rules", note: "trigger is manual/model_decision — the agent does not auto-load it" });
      continue;
    }
    out.push({ path: file, status: "loaded", format: ".agents/rules" });
  }

  // Gemini CLI: single rules file (its AGENTS.md equivalent).
  loaded("GEMINI.md", "Gemini");

  return applyImports(out);
}

/**
 * Claude Code follows @imports: a loaded rules file that says `@AGENTS.md` (or
 * `@docs/rules.md`) makes that file part of what the agent reads. So an imported
 * file is NOT shadowed, and its rules ARE checked. This reconciles `out` with
 * that: any file imported by a loaded file is promoted to loaded (a shadowed
 * AGENTS.md a CLAUDE.md imports flips to loaded), and any imported file not
 * already listed is added as a loaded source. Without imports, `out` is
 * unchanged, so existing projects keep their exact rule order and ids.
 */
function applyImports(out: RuleSource[]): RuleSource[] {
  const imported = new Set<string>();
  for (const src of out) {
    if (src.status !== "loaded") continue;
    for (const target of resolveImports(src.path)) imported.add(resolve(target));
  }
  if (imported.size === 0) return out;

  const present = new Set(out.map((s) => resolve(s.path)));
  for (const src of out) {
    if (src.status === "shadowed" && imported.has(resolve(src.path))) {
      src.status = "loaded";
      src.note = "imported by a loaded CLAUDE.md (@import), so the agent does read it";
    }
  }
  // Imported files that were not otherwise candidates at this level (e.g. a
  // @docs/rules.md), in a stable order so rule ids stay deterministic.
  for (const path of [...imported].sort()) {
    if (present.has(path)) continue;
    present.add(path);
    out.push({ path, status: "loaded", format: "imported (@import)" });
  }
  return out;
}

/** Every rules file at one directory level that the agent actually loads. */
function ruleFilesAtLevel(dir: string): string[] {
  return ruleSourcesAtLevel(dir).filter((s) => s.status === "loaded").map((s) => s.path);
}

/**
 * Walks from the working directory up toward the repository root,
 * collecting rules files at every level.
 *
 * Real gap: rules were only read from the exact directory the command ran
 * in. Claude Code itself applies a rules file to everything beneath it, so
 * in a monorepo the root CLAUDE.md governs `packages/api/` — but running
 * the check inside that package silently missed it, reporting on a subset
 * of the rules that actually applied and never saying so.
 *
 * Stops at the repository root (a directory containing `.git`) so an
 * unrelated rules file further up the filesystem — in a parent workspace,
 * or the home directory — is never pulled into an unrelated project.
 * Global rules are handled separately, deliberately, below.
 */
function projectLevels(cwd: string): string[] {
  const levels: string[] = [];
  const { root } = parse(cwd);
  const home = homedir();
  let dir = cwd;

  for (;;) {
    // The home directory's rules are GLOBAL, and loadRules reads them as
    // such. Guard BEFORE collecting: the original break sat below the push,
    // so the home level was always collected first and every global rule was
    // reported a second time as a project rule. Found 2026-09-08 — a machine
    // with one 14-rule file reported "28 rules checked", doubling every
    // figure on the report. Running from inside the home dir still collects
    // it; loadRules dedupes that against the global pass.
    if (dir === home && dir !== cwd) break;
    levels.push(dir);
    // stop AT the repo root (inclusive) — its rules do apply
    if (existsSync(join(dir, ".git"))) break;
    if (dir === root) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return levels;
}

function findProjectRuleFiles(cwd: string): string[] {
  return projectLevels(cwd).flatMap((dir) => ruleFilesAtLevel(dir));
}

/**
 * Global rules come from every .claude*-prefixed home dir found, not just
 * ~/.claude — a hosted/enterprise Claude Code variant can keep its own
 * global CLAUDE.md under its own home dir (e.g. ~/.claude-office/CLAUDE.md).
 * Real gap found 2026-08-30, same root cause as the transcript-lookup fix
 * in transcriptParser.ts: hardcoding one home-dir name misses any variant.
 *
 * Also reads ~/.claude/rules/*.md, the documented location for personal
 * rules that apply across every project.
 *
 * NOT covered, and stated rather than left silent: machine-wide managed
 * enterprise policy files (/Library/Application Support/ClaudeCode,
 * /etc/claude-code, C:\Program Files\ClaudeCode). Those are deployed by
 * IT, exist on no development machine this can be tested against, and
 * guessing at their location would be the kind of unverified assumption
 * this project has already been bitten by twice.
 */
export function loadRules(cwd: string): Rule[] {
  const rules: Rule[] = [];

  // One file, one set of rules. Globals are read first, so a file reachable
  // both ways keeps its "global" label. Without this, running the check from
  // inside the home directory reported every global rule twice.
  const seen = new Set<string>();
  const read = (path: string, source: "global" | "project") => {
    const key = resolve(path);
    if (seen.has(key)) return;
    seen.add(key);
    rules.push(...parseClaudeMd(path, source));
  };

  for (const dirName of findClaudeHomeDirNames()) {
    const base = join(homedir(), dirName);
    read(join(base, "CLAUDE.md"), "global");
    for (const file of markdownFilesIn(join(base, "rules"))) read(file, "global");
  }

  for (const path of findProjectRuleFiles(cwd)) read(path, "project");

  // Claude Code memory (feedback/project memories) as a rule source, so a
  // standing correction the user moved into memory is still checked and the
  // tool does not go stale against it. Non-office homes only; ids are
  // "memory:<name>", distinct from file-rule ids, so no dedup collision.
  rules.push(...loadMemoryRules(cwd));
  return rules;
}

/** One row of the load graph: a rules file and whether the agent loads it. */
export interface LoadGraphEntry {
  /** Absolute path on disk. */
  path: string;
  scope: "global" | "project";
  status: RuleSourceStatus;
  format: string;
  /** Why a shadowed file is ignored; undefined for loaded files. */
  note?: string;
  /**
   * How many rules the file parses to. For a loaded file this is what the
   * checker uses; for a shadowed file it is how many rules are being IGNORED,
   * which is the number worth showing ("AGENTS.md — 5 rules not applied").
   */
  ruleCount: number;
}

/**
 * The load graph: every candidate rules file the discovery walk sees, in the
 * same order and with the same dedup as `loadRules`, tagged loaded or shadowed
 * and counted. This is what `audit` prints so "why isn't my rule firing?" has
 * an honest, file-level answer — built on the SAME `ruleSourcesAtLevel` the
 * checker's own discovery uses, so the graph can never claim a file was loaded
 * that the checker skipped.
 *
 * Memory rules are deliberately NOT listed here: this graph is about files on
 * disk a user can point at, and memory is summarised separately by the caller.
 */
export function describeRuleSources(cwd: string): LoadGraphEntry[] {
  const entries: LoadGraphEntry[] = [];
  const seen = new Set<string>();
  const add = (src: RuleSource, scope: "global" | "project") => {
    const key = resolve(src.path);
    if (seen.has(key)) return;
    seen.add(key);
    let ruleCount = 0;
    try {
      ruleCount = parseClaudeMd(src.path, scope).length;
    } catch {
      /* unreadable: reported with count 0 rather than dropped */
    }
    entries.push({ path: src.path, scope, status: src.status, format: src.format, note: src.note, ruleCount });
  };

  // Globals first, so a file reachable both ways keeps its "global" label —
  // mirrors loadRules' dedup order exactly.
  for (const dirName of findClaudeHomeDirNames()) {
    const base = join(homedir(), dirName);
    if (existsSync(join(base, "CLAUDE.md"))) add({ path: join(base, "CLAUDE.md"), status: "loaded", format: "Claude (global CLAUDE.md)" }, "global");
    for (const file of markdownFilesIn(join(base, "rules"))) add({ path: file, status: "loaded", format: "Claude (global rules)" }, "global");
  }

  for (const dir of projectLevels(cwd)) {
    for (const src of ruleSourcesAtLevel(dir)) add(src, "project");
  }

  return entries;
}
