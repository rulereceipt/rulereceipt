import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Rule } from "./types.js";

/**
 * User corrections to the tool's guess about what counts as a rule.
 *
 * The classifier decides which lines in a rules file are genuine instructions
 * and which are documentation, using a list of English instruction words. It
 * is wrong in both directions and cannot stop being wrong: imperative verbs
 * are not a closed class, and an English word list cannot match a rule
 * written in another language — measured across 559 public files, non-English
 * content is dropped at 97.5% against a 63.4% baseline.
 *
 * This project's own Rule 5, "No silent scope changes", was filed as
 * documentation and never checked in any report the tool produced, because
 * the rule says "say so explicitly" and `say` is not on that list.
 *
 * So the classifier does not need to be right. It needs to be CORRECTABLE,
 * and to stay corrected. `--show-skipped` makes a mistake visible; this makes
 * the fix permanent. That combination has no coverage gap — it needs no API
 * key, works in any language and any phrasing, and leaves the judgement with
 * whoever wrote the rules.
 */

export type Decision = "rule" | "notARule";

export interface Override {
  /** Content hash of the rule — see ruleFingerprint. */
  hash: string;
  decision: Decision;
  /** Stored for humans reading the file, and to explain a stale entry. */
  title: string;
}

interface OverridesFile {
  version: 1;
  overrides: Override[];
}

export const OVERRIDES_PATH = join(".rulereceipt", "overrides.json");

/**
 * Identifies a rule by its CONTENT, never by its id or position.
 *
 * Rule ids are positional. Editing a rules file renumbers everything after
 * the edit, and the same is true of any upstream change: a parser fix on
 * 2026-09-04 shifted the corpus enough that a seeded sample redrawn at the
 * same seed returned 92 different rules out of 100. An override keyed on
 * position would silently reattach a decision to a rule nobody ever judged,
 * which is the exact failure this feature exists to prevent.
 *
 * Whitespace is normalised so reflowing a paragraph doesn't drop the
 * override, but wording is not: if the rule's words change, it is a different
 * rule and deserves a fresh look.
 */
export function ruleFingerprint(rule: Rule): string {
  const normalised = `${rule.title}\n${rule.text ?? ""}`.replace(/\s+/g, " ").trim();
  return createHash("sha256").update(normalised).digest("hex").slice(0, 12);
}

/** Reads overrides for a project. Absent or unreadable file means none. */
export function loadOverrides(cwd: string): Map<string, Override> {
  const path = join(cwd, OVERRIDES_PATH);
  const map = new Map<string, Override>();
  if (!existsSync(path)) return map;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as OverridesFile;
    if (!Array.isArray(parsed?.overrides)) return map;
    for (const o of parsed.overrides) {
      if (typeof o?.hash === "string" && (o.decision === "rule" || o.decision === "notARule")) {
        map.set(o.hash, { hash: o.hash, decision: o.decision, title: String(o.title ?? "") });
      }
    }
  } catch {
    // A corrupt overrides file must not take the whole check down. The user
    // loses their corrections for this run, which is visible in the report,
    // rather than losing the report entirely.
  }
  return map;
}

/**
 * Writes an override. Only ever called from an explicit command — `check`
 * never writes anything, which is a stated guarantee of this tool.
 */
export function saveOverride(cwd: string, entry: Override): void {
  const path = join(cwd, OVERRIDES_PATH);
  const existing = loadOverrides(cwd);
  existing.set(entry.hash, entry);
  const out: OverridesFile = {
    version: 1,
    overrides: [...existing.values()].sort((a, b) => a.hash.localeCompare(b.hash)),
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`);
}

/** Removes an override, returning whether one was actually there. */
export function clearOverride(cwd: string, hash: string): boolean {
  const existing = loadOverrides(cwd);
  if (!existing.delete(hash)) return false;
  const out: OverridesFile = {
    version: 1,
    overrides: [...existing.values()].sort((a, b) => a.hash.localeCompare(b.hash)),
  };
  const path = join(cwd, OVERRIDES_PATH);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`);
  return true;
}

/**
 * Overrides recorded against rules that are no longer present.
 *
 * Surfaced rather than silently ignored: an override that stopped matching
 * usually means the rule was reworded, and the user should know their
 * correction is no longer being applied instead of assuming it still is.
 */
export function staleOverrides(overrides: Map<string, Override>, rules: Rule[]): Override[] {
  const live = new Set(rules.map(ruleFingerprint));
  return [...overrides.values()].filter((o) => !live.has(o.hash));
}
