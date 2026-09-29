import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { homedir } from "node:os";

/**
 * Claude Code's @import feature: a rules file can pull in another file with an
 * `@path` reference, and the agent reads the imported file's rules as if they
 * were inline. The canonical case is a CLAUDE.md whose entire body is
 * `@AGENTS.md` (the pattern Anthropic's own docs suggest) — the AGENTS.md IS
 * loaded, not shadowed. Missing this made the tool state something untrue ("AGENTS.md
 * present but not loaded") and silently skip every imported rule (found by
 * independent test on 0.1.74, 2026-09-29).
 *
 * Faithful to how Claude Code resolves them, per its docs:
 *  - relative paths resolve against the importing file's directory; `~` is home;
 *  - imports inside code spans (`...`) and fenced code blocks (``` ```) do NOT count;
 *  - a bounded hop depth (5) guards against import cycles.
 * An @token that resolves to something that is not a real file is ignored, which
 * is what keeps an email address (`name@host`) or an @mention from being treated
 * as an import.
 */

const MAX_DEPTH = 5;

/** Blank out fenced code blocks and inline code spans so @tokens inside them are ignored. */
export function stripCodeForImports(md: string): string {
  const lines = md.split(/\r?\n/);
  let inFence = false;
  const out: string[] = [];
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      out.push("");
      continue;
    }
    if (inFence) {
      out.push("");
      continue;
    }
    out.push(line.replace(/`[^`]*`/g, " "));
  }
  return out.join("\n");
}

function realOr(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** The @import paths a file names, resolved to absolute paths (existence not yet checked). */
export function importTargets(filePath: string, content: string): string[] {
  const base = dirname(filePath);
  const stripped = stripCodeForImports(content);
  const targets: string[] = [];
  // An import is `@` at line start or after whitespace, then a path with no spaces.
  const re = /(?:^|\s)@(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    let p = m[1].replace(/[).,;:'"]+$/, ""); // trailing prose punctuation is not part of the path
    if (p.length === 0) continue;
    if (p === "~" || p.startsWith("~/")) p = resolve(homedir(), p.slice(2));
    else if (!isAbsolute(p)) p = resolve(base, p);
    targets.push(p);
  }
  return targets;
}

/**
 * Absolute paths of every file transitively @imported by `filePath`, in a stable
 * order, each confirmed to exist as a real file. `filePath` itself is excluded.
 */
export function resolveImports(filePath: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>([realOr(filePath)]);
  const walk = (fp: string, depth: number) => {
    if (depth >= MAX_DEPTH) return;
    let content: string;
    try {
      content = readFileSync(fp, "utf-8");
    } catch {
      return;
    }
    for (const target of importTargets(fp, content)) {
      const real = realOr(target);
      if (seen.has(real)) continue;
      seen.add(real);
      if (!existsSync(target) || !isFile(target)) continue;
      found.push(target);
      walk(target, depth + 1);
    }
  };
  walk(filePath, 0);
  return found;
}
