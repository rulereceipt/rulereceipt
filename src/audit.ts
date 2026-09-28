import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { classifyRules } from "./checks/classify.js";
import { adviseRules } from "./checkability.js";
import { describeRuleSources, loadRules, type LoadGraphEntry } from "./rules.js";
import type { Rule } from "./types.js";

/**
 * A rules-only health score — how much of a rules file can actually be checked,
 * with NO session needed.
 *
 * The recurring day-one gap: a first `check` with no session is empty, and a
 * real CLAUDE.md is mostly a handbook — measured across the public corpus, ~38%
 * of items are rules and ~56% of those need judgment. `audit` answers "is your
 * rules file enforceable?" on any format (CLAUDE.md, AGENTS.md, Cursor, Copilot,
 * Windsurf, Gemini) instantly, and points at `rules --advise` for the fixes.
 *
 * Buckets, by how classifyRule routes each item:
 *  - checkable : any structured/deterministic kind — a session can be checked
 *                against it without a human or an LLM
 *  - judgment  : needs a person (or `--llm`)
 *  - skipped   : not a rule (docs, directory maps, glossary rows)
 */
export interface RulesAudit {
  total: number;
  checkable: number;
  judgment: number;
  skipped: number;
  /** checkable / (checkable + judgment), whole %, 0 when there are no rules. */
  percentCheckable: number;
  /** The highest-leverage rewrites — a concrete rule missing only its literal. */
  topFixes: { title: string; suggestion: string; handle?: string }[];
}

export function auditRules(rules: Rule[]): RulesAudit {
  let checkable = 0;
  let judgment = 0;
  let skipped = 0;
  for (const c of classifyRules(rules)) {
    if (c.kind === "notARule") skipped++;
    else if (c.kind === "judgment") judgment++;
    else checkable++;
  }
  const decided = checkable + judgment;
  const topFixes = adviseRules(rules)
    .filter((a) => a.actionable)
    .slice(0, 5)
    .map((a) => ({ title: a.ruleTitle, suggestion: a.suggestion, handle: a.handle }));
  return {
    total: checkable + judgment + skipped,
    checkable,
    judgment,
    skipped,
    percentCheckable: decided > 0 ? Math.round((checkable / decided) * 100) : 0,
    topFixes,
  };
}

/** A short, readable audit. Never says "compliant" — it measures the file, not a session. */
export function renderAudit(a: RulesAudit, md = false): string {
  if (a.checkable + a.judgment === 0) {
    return md
      ? "**No rules found** in this project's rules files. Is there a `CLAUDE.md`, `AGENTS.md` or similar here?"
      : "No rules found in this project's rules files.\nIs there a CLAUDE.md / AGENTS.md (or Cursor/Copilot/Windsurf rules) here?";
  }
  const H = (s: string) => (md ? `## ${s}` : s);
  const out: string[] = [];
  out.push(md ? "# RuleReceipt — rules audit" : "RuleReceipt · rules audit  (no session needed)");
  out.push("");
  out.push(`${a.checkable + a.judgment} rules read (plus ${a.skipped} documentation item${a.skipped === 1 ? "" : "s"} not scored).`);
  out.push("");
  out.push(H("Can this session be checked against them?"));
  out.push(`  ${String(a.checkable).padStart(4)}  checkable        — verifiable from a session, no human needed`);
  out.push(`  ${String(a.judgment).padStart(4)}  need judgment    — a person (or \`--llm\`) decides these`);
  out.push(`  ${String(a.skipped).padStart(4)}  documentation    — structure/notes, not scored as rules`);
  out.push("");
  out.push(`${a.percentCheckable}% of your rules can be checked mechanically.`);
  out.push("");
  if (a.topFixes.length > 0) {
    out.push(H("Top fixes to unlock more checks"));
    for (const f of a.topFixes) {
      out.push(`  • ${f.title.replace(/\s+/g, " ").trim().slice(0, 60)}`);
      out.push(`      ${f.suggestion}`);
    }
    out.push("");
  }
  out.push("Full advice, rule by rule:  rulereceipt rules --advise");
  return out.join("\n");
}

/**
 * A file-level problem the audit can name WITHOUT a session: things that stop a
 * rules file from ever reaching the agent as a useful rule. Deliberately about
 * load / shape / checkability only — never "the model ignored you," which this
 * cannot know without a transcript.
 */
export interface Diagnostic {
  id:
    | "no-rules-file"
    | "empty-or-pointer"
    | "zero-rules"
    | "docs-heavy"
    | "shadowed-file"
    | "size-warn"
    | "template-text"
    | "broken-import"
    | "hook-config";
  severity: "info" | "warn";
  message: string;
}

/** Hook events Claude Code recognises. A hook under any other name never fires. */
const KNOWN_HOOK_EVENTS = new Set([
  "PreToolUse", "PostToolUse", "Stop", "SubagentStop", "UserPromptSubmit",
  "SessionStart", "SessionEnd", "Notification", "PreCompact", "PostCompact",
  "PermissionRequest", "PermissionDenied", "InstructionsLoaded",
]);

/** Hook event names in the project/user settings that Claude Code won't recognise. */
function unknownHookEvents(cwd: string): string[] {
  const bad = new Set<string>();
  for (const p of [join(cwd, ".claude", "settings.json"), join(cwd, ".claude", "settings.local.json")]) {
    try {
      const hooks = (JSON.parse(readFileSync(p, "utf-8")) as { hooks?: Record<string, unknown> }).hooks;
      if (hooks && typeof hooks === "object") {
        for (const name of Object.keys(hooks)) if (!KNOWN_HOOK_EVENTS.has(name)) bad.add(name);
      }
    } catch {
      /* absent or unreadable */
    }
  }
  return [...bad];
}

/**
 * Claude Code reads a bounded prefix of a rules file; past it the rest is
 * silently dropped, so a rule below the cut never loads. The figure is a
 * conservative approximation (character count, not bytes, so non-English files
 * aren't over-counted) and is WARN-only — never a FAIL. TODO: pin to the exact
 * current documented limit before leaning on the number in marketing.
 */
const SIZE_WARN_CHARS = 40000;

/** Placeholder text left in from a template — the rule was never actually written. */
const TEMPLATE_TEXT = /\[your\s+[^\]]+\]|<your\s+[^>]+>|\[project[_ ]name\]|\[TODO\]|^\s*(?:TODO|FIXME)\s*:/im;

/** Fenced and inline code, masked before scanning for imports/placeholders. */
function stripCode(text: string): string {
  return text.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`/g, " ");
}

/**
 * `@path` imports the agent follows. Conservative on purpose: only an `@` at a
 * word start (so an email's `@` never counts), and only when the target looks
 * like a file — has a rules-file extension, or starts with `./ ../ /`. That
 * excludes npm scopes like `@types/node` (no extension, no `./`), which are the
 * classic false positive. Resolved relative to the importing file.
 */
const IMPORT_LINE = /(?:^|[\s(])@((?:\.{0,2}\/)?[\w./-]+\.(?:md|markdown|mdc|txt)|(?:\.{1,2}\/|\/)[\w./-]+)/g;

function brokenImports(filePath: string, text: string): string[] {
  const dir = dirname(filePath);
  const broken: string[] = [];
  for (const m of stripCode(text).matchAll(IMPORT_LINE)) {
    const target = m[1];
    const abs = isAbsolute(target) ? target : resolve(dir, target);
    if (!existsSync(abs)) broken.push(target);
  }
  return broken;
}

/** The full doorstep audit for a project: counts + load graph + diagnostics. */
export interface ProjectAudit extends RulesAudit {
  /** Every candidate rules file the walk saw, loaded or shadowed. */
  loadGraph: LoadGraphEntry[];
  /** File-level problems worth surfacing before any session. */
  diagnostics: Diagnostic[];
  /** How many rules came from Claude Code memory (not a file, so not in loadGraph). */
  memoryRules: number;
}

/** Content that is a pointer to another file, not rules of its own ("see AGENTS.md"). */
const POINTER = /^\s*(?:#[^\n]*\n)?\s*(?:see|refer\s+to|read|follow|use|check)\b[^\n]{0,80}?\.(?:md|markdown|txt|mdc)\b/i;

function isPointerFile(path: string): boolean {
  try {
    const text = readFileSync(path, "utf-8").trim();
    return text.length > 0 && text.length < 220 && POINTER.test(text);
  } catch {
    return false;
  }
}

function buildDiagnostics(cwd: string, graph: LoadGraphEntry[], a: RulesAudit): Diagnostic[] {
  const diags: Diagnostic[] = [];
  const loaded = graph.filter((g) => g.status === "loaded");
  const shadowed = graph.filter((g) => g.status === "shadowed");
  const short = (p: string) => {
    const r = relative(cwd, p);
    return r && !r.startsWith("..") ? r : p;
  };

  // Nothing to check against at all.
  if (loaded.length === 0 && a.total === 0) {
    diags.push({
      id: "no-rules-file",
      severity: "warn",
      message: "No rules file found. Add a CLAUDE.md or AGENTS.md at the repo root (or .cursor/rules, copilot-instructions.md, .windsurfrules, GEMINI.md) with the rules you want checked.",
    });
    return diags;
  }

  // A shadowed file is present but the agent ignores it — the single most
  // confusing "why isn't my rule firing?" case, so it leads.
  for (const s of shadowed) {
    const ignored = s.ruleCount > 0 ? ` — ${s.ruleCount} rule${s.ruleCount === 1 ? "" : "s"} not applied` : "";
    diags.push({
      id: "shadowed-file",
      severity: "warn",
      message: `${short(s.path)} is present but not loaded (${s.note})${ignored}.`,
    });
  }

  // Loaded files that carry no rules of their own: empty, or just a pointer to
  // another file. A pointer parses to a rule or two ("See AGENTS.md"), so it is
  // caught by content, not only by a zero count.
  for (const l of loaded) {
    if (l.ruleCount === 0) {
      diags.push({ id: "empty-or-pointer", severity: "warn", message: `${short(l.path)} is loaded but has no rules in it yet.` });
    } else if (l.ruleCount <= 2 && isPointerFile(l.path)) {
      diags.push({
        id: "empty-or-pointer",
        severity: "warn",
        message: `${short(l.path)} only points to another file — put the actual rules where the agent will read them, or use an @import the agent follows.`,
      });
    }
  }

  // Files exist and load, but nothing parsed as a rule anywhere.
  if (loaded.length > 0 && a.total === 0) {
    diags.push({
      id: "zero-rules",
      severity: "warn",
      message: "Rules files were loaded but none parsed into a rule. Use headings, numbered items, or `-` bullets so each rule stands on its own.",
    });
  }

  // Content-level problems on each loaded file: silent truncation, leftover
  // template text, and imports that resolve to nothing. Read once per file.
  for (const l of loaded) {
    let text = "";
    try {
      text = readFileSync(l.path, "utf-8");
    } catch {
      continue;
    }
    if (text.length > SIZE_WARN_CHARS) {
      diags.push({
        id: "size-warn",
        severity: "warn",
        message: `${short(l.path)} is ${text.length.toLocaleString()} characters — large rules files can be silently truncated, so rules near the end may never load. Split it or trim.`,
      });
    }
    if (TEMPLATE_TEXT.test(text)) {
      diags.push({
        id: "template-text",
        severity: "warn",
        message: `${short(l.path)} still has template placeholder text (e.g. "[your project name]", "TODO:") — fill it in or remove it so it reads as a real rule.`,
      });
    }
    const broken = brokenImports(l.path, text);
    if (broken.length > 0) {
      diags.push({
        id: "broken-import",
        severity: "warn",
        message: `${short(l.path)} imports ${broken.slice(0, 3).map((b) => `@${b}`).join(", ")}${broken.length > 3 ? ` (+${broken.length - 3} more)` : ""} — the file doesn't exist, so nothing loads from it.`,
      });
    }
  }

  // A hook wired under a misspelled/unknown event name never fires — silently.
  const badHooks = unknownHookEvents(cwd);
  if (badHooks.length > 0) {
    diags.push({
      id: "hook-config",
      severity: "warn",
      message: `.claude/settings.json has hook${badHooks.length === 1 ? "" : "s"} under ${badHooks.map((h) => `"${h}"`).join(", ")}, which ${badHooks.length === 1 ? "is not a" : "are not"} Claude Code hook event${badHooks.length === 1 ? "" : "s"} — ${badHooks.length === 1 ? "it never fires" : "they never fire"}. Check the spelling (e.g. PreToolUse, PostToolUse, Stop).`,
    });
  }

  // A handbook, not a policy: mostly documentation, little to enforce.
  if (a.total >= 8 && a.skipped / a.total > 0.7) {
    diags.push({
      id: "docs-heavy",
      severity: "info",
      message: `${a.skipped} of ${a.total} items are documentation, not rules. That's fine — but for the lines you want enforced, phrase them as Never/Always and put the command, file or branch in \`backticks\`.`,
    });
  }

  return diags;
}

/**
 * The doorstep audit: what loaded, what's checkable, what to fix — no session.
 * `check` proves what a real session did; this answers the day-one questions a
 * cold `npx rulereceipt audit` should, before any transcript exists.
 */
export function auditProject(cwd: string): ProjectAudit {
  const rules = loadRules(cwd);
  const base = auditRules(rules);
  const loadGraph = describeRuleSources(cwd);
  const diagnostics = buildDiagnostics(cwd, loadGraph, base);
  const memoryRules = rules.filter((r) => r.id.startsWith("memory:")).length;
  return { ...base, loadGraph, diagnostics, memoryRules };
}

/** The doorstep render: load graph → summary → diagnostics → top fixes. */
export function renderProjectAudit(pa: ProjectAudit, md = false): string {
  const H = (s: string) => (md ? `## ${s}` : s);
  const out: string[] = [];
  out.push(md ? "# RuleReceipt — rules audit" : "RuleReceipt · rules audit  (no session needed)");
  out.push("");

  const loaded = pa.loadGraph.filter((g) => g.status === "loaded");
  const shadowed = pa.loadGraph.filter((g) => g.status === "shadowed");

  out.push(H("Rules files found"));
  if (pa.loadGraph.length === 0) {
    out.push("  (none — no CLAUDE.md / AGENTS.md / Cursor / Copilot / Windsurf / Gemini rules on the path)");
  } else {
    for (const g of loaded) {
      out.push(`  loaded    ${g.format} · ${g.ruleCount} rule${g.ruleCount === 1 ? "" : "s"}  (${g.path})`);
    }
    for (const g of shadowed) {
      out.push(`  ignored   ${g.format} · ${g.note}  (${g.path})`);
    }
    if (pa.memoryRules > 0) out.push(`  loaded    Claude memory · ${pa.memoryRules} rule${pa.memoryRules === 1 ? "" : "s"}`);
  }
  out.push("");

  if (pa.checkable + pa.judgment > 0) {
    out.push(H("Can this session be checked against them?"));
    out.push(`  ${String(pa.checkable).padStart(4)}  checkable        — verifiable from a session, no human needed`);
    out.push(`  ${String(pa.judgment).padStart(4)}  need judgment    — a person (or \`--llm\`) decides these`);
    out.push(`  ${String(pa.skipped).padStart(4)}  documentation    — structure/notes, not scored as rules`);
    out.push("");
    out.push(`${pa.percentCheckable}% of your rules can be checked mechanically.`);
    out.push("");
  }

  if (pa.diagnostics.length > 0) {
    out.push(H("What to fix in the setup"));
    for (const d of pa.diagnostics) out.push(`  ${d.severity === "warn" ? "!" : "·"} ${d.message}`);
    out.push("");
  }

  if (pa.topFixes.length > 0) {
    out.push(H("Top fixes to unlock more checks"));
    for (const f of pa.topFixes) {
      out.push(`  • ${f.title.replace(/\s+/g, " ").trim().slice(0, 60)}${f.handle ? `  [${f.handle}]` : ""}`);
      out.push(`      ${f.suggestion}`);
    }
    out.push("");
  }

  out.push("Full advice, rule by rule:  rulereceipt rules --advise");
  out.push("After you run your agent here:  rulereceipt check   (rule-by-rule proof from the session)");
  return out.join("\n");
}
