import { homedir } from "node:os";
import { dirname, join, parse, relative, resolve } from "node:path";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { parseClaudeMd } from "./parsers/readClaudeMd.js";
import { claudeHomes } from "./parsers/transcriptParser.js";
import { loadMemoryRules, memoryGraphEntry } from "./parsers/readMemory.js";
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
  /**
   * The status is not certain: whether this file loads depends on the user's
   * Claude Code version and/or `/config` "Project instructions" setting, which we
   * could not read. Reporting says "may not be loaded", never a flat "not
   * loaded". Only set on an AGENTS(.md) shadowed by a CLAUDE file when the
   * setting is undetermined.
   */
  uncertain?: boolean;
}

/**
 * Claude Code's `/config` → "Project instructions" setting decides whether an
 * AGENTS.md is read when a CLAUDE.md is also present (added in Claude Code
 * 2.1.277; https://devops.com/claude-code-adds-agents-md-fallback-cutting-instruction-file-sprawl/):
 *   - `claude-md-or-agents-md` (default) — CLAUDE.md wins; AGENTS.md only when no CLAUDE.md.
 *   - `claude-md-and-agents-md`          — loads BOTH (CLAUDE.md first).
 *   - `claude-md`                        — ignores AGENTS.md entirely.
 *   - `managed-only`                     — only the org-managed CLAUDE.md + auto memory.
 * We can only make a definite statement about AGENTS.md if we can read this. It
 * is an in-app setting and often not on disk, so the usual answer is "unknown",
 * and we say "may not be loaded" rather than asserting it is shadowed.
 */
export type ProjectInstructions = "both" | "claude-only" | "claude-wins" | "managed-only" | "unknown";
const PI_LITERALS: [string, ProjectInstructions][] = [
  ["claude-md-and-agents-md", "both"],
  ["claude-md-or-agents-md", "claude-wins"],
  ["managed-only", "managed-only"],
  ["claude-md", "claude-only"],
];
export function projectInstructionsSetting(cwd: string): ProjectInstructions {
  const files = [
    join(cwd, ".claude", "settings.json"),
    join(cwd, ".claude", "settings.local.json"),
    join(homedir(), ".claude", "settings.json"),
    join(homedir(), ".claude", "settings.local.json"),
  ];
  for (const f of files) {
    let txt: string;
    try {
      txt = readFileSync(f, "utf-8");
    } catch {
      continue;
    }
    // Match the exact quoted value, robust to the setting's key name (which we
    // do not hardcode). Longest literals first so `claude-md` can't shadow
    // `claude-md-and-agents-md`.
    for (const [literal, mode] of PI_LITERALS) {
      if (txt.includes(`"${literal}"`)) return mode;
    }
  }
  return "unknown";
}

/**
 * Every candidate rules file at one directory level, in documented load order,
 * each tagged loaded or shadowed. This is the single source of truth for both
 * what gets checked (`ruleFilesAtLevel`, the loaded subset) and the load graph
 * (`describeRuleSources`) — so the report can never claim a file was loaded
 * that the checker skipped, or vice versa.
 */
function ruleSourcesAtLevel(dir: string, pi: ProjectInstructions = "unknown", agentTool = "claude-code"): RuleSource[] {
  const out: RuleSource[] = [];
  const has = (rel: string) => existsSync(join(dir, rel));
  const pushAgentsChain = () => {
    if (has("AGENTS.md")) out.push({ path: join(dir, "AGENTS.md"), status: "loaded", format: "AGENTS.md" });
    if (has("AGENT.md")) out.push({ path: join(dir, "AGENT.md"), status: "loaded", format: "AGENT.md" });
    if (has("AGENTS.local.md")) out.push({ path: join(dir, "AGENTS.local.md"), status: "loaded", format: "AGENTS (AGENTS.local.md)" });
  };

  // Codex reads the AGENTS.md family ONLY — never CLAUDE.md, .cursor, Copilot,
  // Windsurf, Gemini or ~/.claude. Checking a Codex session against a file Codex
  // never opens is a false accusation, so for a Codex session we load just the
  // AGENTS chain at this level (verified against a real 0.160.1 rollout).
  if (agentTool === "codex") {
    pushAgentsChain();
    return applyImports(out);
  }

  // Copilot CLI reads AGENTS.md + the repo's .github/copilot-instructions.md —
  // not CLAUDE.md, Cursor, Windsurf, Gemini or ~/.claude (validated on a real
  // 1.0.92 session, which read AGENTS.md and ignored the rest).
  if (agentTool === "copilot-cli") {
    pushAgentsChain();
    if (has(join(".github", "copilot-instructions.md"))) out.push({ path: join(dir, ".github", "copilot-instructions.md"), status: "loaded", format: "Copilot" });
    return applyImports(out);
  }

  // Antigravity (Google; replaced Gemini CLI) reads AGENTS.md + GEMINI.md — not
  // CLAUDE.md, Cursor, Copilot, Windsurf or ~/.claude (validated on a real 1.3.1
  // session, which loaded AGENTS.md).
  if (agentTool === "antigravity") {
    pushAgentsChain();
    if (has("GEMINI.md")) out.push({ path: join(dir, "GEMINI.md"), status: "loaded", format: "Gemini (GEMINI.md)" });
    return applyImports(out);
  }

  // Cursor reads AGENTS.md + .cursor/rules/*.mdc|.md (the modern dir supersedes the
  // legacy .cursorrules) — not CLAUDE.md, Copilot, Windsurf, Gemini or ~/.claude
  // (validated on a real session, which read AGENTS.md).
  if (agentTool === "cursor") {
    pushAgentsChain();
    const cursorRules = markdownFilesIn(join(dir, ".cursor", "rules"), [".mdc", ".md"]);
    if (cursorRules.length > 0) {
      for (const f of cursorRules) out.push({ path: f, status: "loaded", format: "Cursor (.cursor/rules)" });
    } else if (has(".cursorrules")) {
      out.push({ path: join(dir, ".cursorrules"), status: "loaded", format: "Cursor (.cursorrules)" });
    }
    return applyImports(out);
  }
  const loaded = (rel: string, format: string, note?: string) => {
    if (has(rel)) out.push({ path: join(dir, rel), status: "loaded", format, note });
  };
  const shadowed = (rel: string, format: string, note: string) => {
    if (has(rel)) out.push({ path: join(dir, rel), status: "shadowed", format, note });
  };
  // An AGENTS(.md) sitting beside a CLAUDE file: whether it loads depends on the
  // /config "Project instructions" setting (see projectInstructionsSetting).
  // Setting-aware, and honest when undetermined — "may not be loaded", never a
  // flat "not loaded".
  const agentsBesideClaude = (rel: string, format: string, winner: string) => {
    if (!has(rel)) return;
    const path = join(dir, rel);
    if (pi === "both") {
      out.push({ path, status: "loaded", format, note: `loaded alongside ${winner}: /config "Project instructions" = claude-md-and-agents-md` });
    } else if (pi === "claude-only") {
      out.push({ path, status: "shadowed", format, note: `/config "Project instructions" = claude-md ignores AGENTS.md` });
    } else if (pi === "managed-only") {
      out.push({ path, status: "shadowed", format, note: `/config "Project instructions" = managed-only loads only the org CLAUDE.md` });
    } else if (pi === "claude-wins") {
      out.push({ path, status: "shadowed", format, note: `${winner} at the same level wins (/config "Project instructions" = claude-md-or-agents-md)` });
    } else {
      // unknown: do not assert. It loads iff /config is claude-md-and-agents-md,
      // which needs Claude Code 2.1.277+. We can't read the version or setting.
      out.push({ path, status: "shadowed", format, uncertain: true, note: `may not be loaded — depends on your Claude Code version (AGENTS.md needs 2.1.277+) and /config "Project instructions" (set claude-md-and-agents-md to load it beside ${winner})` });
    }
  };

  // CLAUDE.md beside AGENTS.md in .claude/: same setting-driven rule.
  if (has(join(".claude", "CLAUDE.md"))) {
    loaded(join(".claude", "CLAUDE.md"), "Claude (.claude/CLAUDE.md)");
    agentsBesideClaude(join(".claude", "AGENTS.md"), "AGENTS (.claude/AGENTS.md)", ".claude/CLAUDE.md");
  } else {
    loaded(join(".claude", "AGENTS.md"), "AGENTS (.claude/AGENTS.md)");
  }

  for (const rel of RULE_DIRS) {
    for (const f of markdownFilesIn(join(dir, rel))) out.push({ path: f, status: "loaded", format: ".claude/rules" });
  }

  // AGENTS.md / AGENT.md load ONLY when this level has no Claude file at all.
  // As of Claude Code 2.1.277 (default "Project instructions" = claude-md-or-
  // agents-md), AGENTS.md is read only when none of CLAUDE.md / CLAUDE.local.md
  // (nor .claude/CLAUDE.md, handled above) exists — so CLAUDE.local.md ALSO
  // shadows AGENTS.md, not just CLAUDE.md. Checking a shadowed AGENTS.md would be
  // a false accusation (it never reaches the agent).
  // KNOWN LIMIT: the 2.1.277 rule is "no Claude file in cwd OR ABOVE"; this
  // shadows at the SAME level only. A parent CLAUDE.md shadowing a child
  // AGENTS.md across levels is not yet modelled (see KNOWN-GAPS).
  const hasClaudeMd = has("CLAUDE.md");
  const hasClaudeLocal = has("CLAUDE.local.md");
  if (hasClaudeMd) loaded("CLAUDE.md", "Claude (CLAUDE.md)");
  // .local always loads alongside the base CLAUDE.md when present.
  if (hasClaudeLocal) loaded("CLAUDE.local.md", "Claude (CLAUDE.local.md)");
  if (hasClaudeMd || hasClaudeLocal) {
    const winner = hasClaudeMd ? "CLAUDE.md" : "CLAUDE.local.md";
    agentsBesideClaude("AGENTS.md", "AGENTS.md", winner);
    agentsBesideClaude("AGENT.md", "AGENT.md", winner);
  } else {
    loaded("AGENTS.md", "AGENTS.md");
    loaded("AGENT.md", "AGENT.md");
  }
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
function ruleFilesAtLevel(dir: string, pi: ProjectInstructions, agentTool = "claude-code"): string[] {
  return ruleSourcesAtLevel(dir, pi, agentTool).filter((s) => s.status === "loaded").map((s) => s.path);
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

function findProjectRuleFiles(cwd: string, pi: ProjectInstructions, agentTool = "claude-code"): string[] {
  return projectLevels(cwd).flatMap((dir) => ruleFilesAtLevel(dir, pi, agentTool));
}

/**
 * Directories we never descend into when looking for subfolder rules files:
 * build output, dependencies, VCS internals, RuleReceipt's own state.
 */
const SKIP_DESCEND = new Set([
  "node_modules", ".git", "dist", "build", ".next", "out", "coverage",
  ".rulereceipt", ".vercel", ".turbo", "vendor", ".cache", "tmp", ".venv",
  "__pycache__", "target",
]);
// Bounded so scanning a large workspace root can never run away.
const MAX_DESCEND_DEPTH = 8;
const MAX_DESCEND_DIRS = 3000;

/**
 * Every directory strictly BELOW cwd, bounded. The up-walk (`projectLevels`)
 * covers cwd and its ancestors; this covers its descendants.
 *
 * Why descend at all: Claude Code loads a subfolder CLAUDE.md/AGENTS.md on
 * demand the moment the session touches a file in that subtree (surfaced in the
 * transcript as a `nested_memory` attachment). The up-only walk never saw
 * these, so running `check` from a parent dir silently missed every subfolder
 * rules file — proven 2026-10-03 against real `nested_memory` ground truth
 * (e.g. `costrr/CLAUDE.md`, `Daily _crypto/CLAUDE.md` loaded while cwd was the
 * parent workspace). Nested git repos are NOT a stop condition here: Claude's
 * nested_memory loads a nested-repo CLAUDE.md too, so we must find it.
 */
function descendantLevels(cwd: string): string[] {
  const out: string[] = [];
  // Breadth-first on purpose: a shallow subfolder rules file is the common case
  // and the one most likely to have been loaded, so when the dir budget runs
  // out on a large workspace root it is the DEEP dirs that are dropped, never
  // the shallow siblings. (A depth-first walk with the same budget could dive
  // into one big subtree and starve a sibling's depth-1 CLAUDE.md — the bug this
  // replaces, caught 2026-10-03 when costrr/ and rulereceipt/ were missed from a
  // workspace root.)
  let queue: { dir: string; depth: number }[] = [{ dir: cwd, depth: 0 }];
  let budget = MAX_DESCEND_DIRS;
  while (queue.length > 0 && budget > 0) {
    const next: { dir: string; depth: number }[] = [];
    for (const { dir, depth } of queue) {
      if (budget <= 0) break;
      let entries: import("node:fs").Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (budget <= 0) break;
        if (!e.isDirectory()) continue;
        if (SKIP_DESCEND.has(e.name) || e.name.startsWith(".")) continue; // dotdirs hold tooling, not project subtrees
        const full = join(dir, e.name);
        budget--;
        out.push(full);
        if (depth + 1 < MAX_DESCEND_DEPTH) next.push({ dir: full, depth: depth + 1 });
      }
    }
    queue = next;
  }
  return out;
}

/** The glob that scopes a subfolder rules file to its own subtree, relative to cwd. */
function subtreeGlob(cwd: string, dir: string): string {
  const rel = relative(cwd, dir).replace(/\\/g, "/");
  return `${rel}/**`;
}

/**
 * Subfolder rules files below cwd, each paired with the subtree glob that
 * scopes it. A subfolder rule is only applied to a session that actually
 * touched its subtree (the same path-scope machinery as `paths:` frontmatter),
 * so discovering them can never manufacture a false accusation against a
 * session that never worked there.
 */
function scopedRuleFilesBelow(cwd: string, pi: ProjectInstructions, agentTool = "claude-code"): { path: string; scopeGlob: string }[] {
  const out: { path: string; scopeGlob: string }[] = [];
  for (const dir of descendantLevels(cwd)) {
    const glob = subtreeGlob(cwd, dir);
    for (const path of ruleFilesAtLevel(dir, pi, agentTool)) out.push({ path, scopeGlob: glob });
  }
  return out;
}

/**
 * Global rules come from every configured Claude home (see claudeHomes): the
 * standard ~/.claude, plus any the user names via CLAUDE_CONFIG_DIR or
 * RULERECEIPT_CLAUDE_HOMES — so a hosted/enterprise variant with its own global
 * CLAUDE.md is supported when the user points at it, rather than by scanning
 * whatever ~/.claude* dirs happen to exist on the machine.
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
export function loadRules(cwd: string, agentTool = "claude-code"): Rule[] {
  const rules: Rule[] = [];
  const isCodex = agentTool === "codex";
  const isClaude = agentTool === "claude-code";

  // One file, one set of rules. Globals are read first, so a file reachable
  // both ways keeps its "global" label. Without this, running the check from
  // inside the home directory reported every global rule twice.
  const seen = new Set<string>();
  const read = (path: string, source: "global" | "project", scopeGlob?: string) => {
    const key = resolve(path);
    if (seen.has(key)) return;
    seen.add(key);
    let parsed = parseClaudeMd(path, source);
    // A subfolder rules file is loaded by the agent only when the session works
    // in its subtree, so it is scoped to that subtree unless the file's own
    // frontmatter already carries a (narrower) `paths:`.
    if (scopeGlob) {
      parsed = parsed.map((r) => (r.paths && r.paths.length > 0 ? r : { ...r, paths: [scopeGlob] }));
    }
    rules.push(...parsed);
  };

  // Global rules. Codex reads ~/.codex/AGENTS.md (its global AGENTS.md). Claude
  // Code reads every configured Claude home. Copilot CLI has no global rules
  // file we load — neither reads ~/.claude.
  if (isCodex) {
    read(join(homedir(), ".codex", "AGENTS.md"), "global");
  } else if (isClaude) {
    for (const base of claudeHomes()) {
      read(join(base, "CLAUDE.md"), "global");
      for (const file of markdownFilesIn(join(base, "rules"))) read(file, "global");
    }
  }

  // /config "Project instructions" is a Claude Code setting; it does not apply to
  // Codex or Copilot (which only read the AGENTS.md family / their own file).
  const pi = isClaude ? projectInstructionsSetting(cwd) : "unknown";
  for (const path of findProjectRuleFiles(cwd, pi, agentTool)) read(path, "project");
  // Subfolder rules files (below cwd), each scoped to its own subtree.
  for (const { path, scopeGlob } of scopedRuleFilesBelow(cwd, pi, agentTool)) read(path, "project", scopeGlob);

  // Claude Code memory (feedback/project memories) as a rule source, so a
  // standing correction the user moved into memory is still checked and the
  // tool does not go stale against it. Non-office homes only; ids are
  // "memory:<name>", distinct from file-rule ids, so no dedup collision.
  // Only Claude Code reads Claude memory.
  if (isClaude) rules.push(...loadMemoryRules(cwd));
  return dedupeRuleText(rules);
}

/**
 * Identical rule text in more than one file (e.g. a project with both AGENTS.md
 * and CLAUDE.md carrying the same rules) is ONE rule, not several — counting it
 * twice inflates the report and shows the same verdict twice. Dedupe by
 * (scope, normalised title+text, path-scope), keep the first occurrence, and
 * record every other file it appeared in on `alsoSources` so the report still
 * names them all.
 */
function dedupeRuleText(rules: Rule[]): Rule[] {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const out: Rule[] = [];
  const byKey = new Map<string, Rule>();
  for (const r of rules) {
    const scope = (r.paths ?? []).slice().sort().join(",");
    const key = `${r.source}\u0000${norm(r.title)}\u0000${norm(r.text)}\u0000${scope}`;
    const first = byKey.get(key);
    if (!first) {
      byKey.set(key, r);
      out.push(r);
    } else if (r.sourcePath && r.sourcePath !== first.sourcePath && !(first.alsoSources ?? []).some((s) => s.sourcePath === r.sourcePath)) {
      (first.alsoSources ??= []).push({ sourcePath: r.sourcePath, sourceLine: r.sourceLine });
    }
  }
  return out;
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
  /** The status is not certain (depends on Claude Code version / config). See RuleSource.uncertain. */
  uncertain?: boolean;
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
    entries.push({ path: src.path, scope, status: src.status, format: src.format, note: src.note, uncertain: src.uncertain, ruleCount });
  };
  const pi = projectInstructionsSetting(cwd);

  // Globals first, so a file reachable both ways keeps its "global" label —
  // mirrors loadRules' dedup order exactly.
  for (const base of claudeHomes()) {
    if (existsSync(join(base, "CLAUDE.md"))) add({ path: join(base, "CLAUDE.md"), status: "loaded", format: "Claude (global CLAUDE.md)" }, "global");
    for (const file of markdownFilesIn(join(base, "rules"))) add({ path: file, status: "loaded", format: "Claude (global rules)" }, "global");
  }

  for (const dir of projectLevels(cwd)) {
    for (const src of ruleSourcesAtLevel(dir, pi)) add(src, "project");
  }

  // Subfolder rules files below cwd: loaded on demand when the session works in
  // their subtree. Tagged so the graph says WHY they are conditional, matching
  // the subtree scope `loadRules` applies.
  for (const dir of descendantLevels(cwd)) {
    const rel = relative(cwd, dir).replace(/\\/g, "/");
    for (const src of ruleSourcesAtLevel(dir, pi)) {
      if (src.status !== "loaded") {
        add(src, "project");
        continue;
      }
      add(
        { ...src, note: `subfolder rules — loaded when the agent works in ${rel}/` },
        "project"
      );
    }
  }

  // Claude Code memory, as its own load-graph row. loadRules already CHECKS
  // memory rules; listing them here closes the reporting gap where the graph
  // undercounted what the checker uses (found 2026-10-03). Office homes are
  // excluded inside the memory loader.
  const mem = memoryGraphEntry(cwd);
  if (mem && !seen.has(resolve(mem.path))) {
    seen.add(resolve(mem.path));
    entries.push({ path: mem.path, scope: "project", status: "loaded", format: "Claude memory", ruleCount: mem.ruleCount });
  }

  return entries;
}
