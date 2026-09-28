import { checkSessionInBrowser } from "./browser/evaluateBrowser.js";
import type { CheckResult } from "./types.js";

/**
 * `rulereceipt selftest` — proof anyone can run.
 *
 * It runs a set of bundled golden fixtures (a rule + a session with a known,
 * hand-checked verdict) through the exact same checkers the tool uses, on the
 * user's own machine, and reports "N checks, all correct". It makes ZERO
 * network calls by construction — everything here is the pure evaluator — so a
 * skeptical developer can watch it with `lsof`/Little Snitch and confirm the
 * "nothing is uploaded" claim for themselves. Every fixture is also a
 * regression: a change that breaks one of these fails the build via the test
 * that runs this function.
 */

interface Golden {
  name: string;
  rules: string;
  session: string;
  /** For each expected rule, the verdict its title should get. */
  expect: { title: RegExp; want: CheckResult["status"] | "not-fail" }[];
}

function sessionOf(lines: unknown[]): string {
  return lines.map((l) => JSON.stringify(l)).join("\n");
}
const asst = (content: unknown[]) => ({ type: "assistant", timestamp: "t", message: { role: "assistant", content } });
const user = (content: string, permissionMode?: string) => ({ type: "user", timestamp: "t", permissionMode, message: { role: "user", content } });
const bash = (command: string, id = "x") => ({ type: "tool_use", id, name: "Bash", input: { command } });
const edit = (file_path: string) => ({ type: "tool_use", id: "e", name: "Edit", input: { file_path, old_string: "a", new_string: "b" } });

const GOLDENS: Golden[] = [
  {
    name: "push with no approval in a no-prompt mode is Broken",
    rules: "## 1. Never push without asking\nNever push without explicit user instruction.\n",
    session: sessionOf([user("fix the page", "bypassPermissions"), asst([bash("git push origin main", "a")])]),
    expect: [{ title: /never push/i, want: "FAIL" }],
  },
  {
    name: "push the user asked for is Followed",
    rules: "## 1. Never push without asking\nNever push without explicit user instruction.\n",
    session: sessionOf([user("fix it and push it", "bypassPermissions"), asst([bash("git push origin main", "a")])]),
    expect: [{ title: /never push/i, want: "PASS" }],
  },
  {
    name: "push in default mode is Can't-tell (a prompt may have been approved)",
    rules: "## 1. Never push without asking\nNever push without explicit user instruction.\n",
    session: sessionOf([user("fix the page", "default"), asst([bash("git push origin main", "a")])]),
    expect: [{ title: /never push/i, want: "not-fail" }],
  },
  {
    name: "console.log written into a file is Broken",
    rules: "## 1. No debug logging\nNever leave a `console.log(` call in committed code.\n",
    session: sessionOf([asst([{ type: "tool_use", id: "w", name: "Write", input: { file_path: "app.ts", content: "console.log(1)" } }])]),
    expect: [{ title: /debug logging/i, want: "FAIL" }],
  },
  {
    name: "editing .env is Broken",
    rules: "## 1. Never edit `.env`\nNever edit `.env`.\n",
    session: sessionOf([asst([edit(".env")])]),
    expect: [{ title: /never edit/i, want: "FAIL" }],
  },
  {
    name: "a Co-Authored-By trailer is Broken",
    rules: "## 1. No AI attribution\nNever add a `Co-Authored-By: Claude` trailer to git commits.\n",
    session: sessionOf([asst([bash("git commit -m 'x\n\nCo-Authored-By: Claude <noreply@anthropic.com>'", "c")])]),
    expect: [{ title: /attribution/i, want: "FAIL" }],
  },
  {
    name: "a temp-dir rm is NOT Broken against a 'never wipe databases' rule",
    rules: "## 1. Never wipe databases\nBefore any delete on the database, wait for explicit confirmation.\n",
    session: sessionOf([asst([bash("rm -rf /tmp/scratch-xyz", "r")])]),
    expect: [{ title: /wipe databases/i, want: "not-fail" }],
  },
  {
    name: "a judgment rule is Can't-tell, never Broken",
    rules: "## 1. Keep changes small\nAlways keep changes small and focused.\n",
    session: sessionOf([asst([bash("git commit -m x", "c")])]),
    expect: [{ title: /keep changes small/i, want: "UNCLEAR" }],
  },
];

export interface SelfTestResult {
  total: number;
  passed: number;
  failures: { name: string; detail: string }[];
}

export function runSelfTestChecks(): SelfTestResult {
  const failures: { name: string; detail: string }[] = [];
  let total = 0;
  for (const g of GOLDENS) {
    const results = checkSessionInBrowser(g.rules, g.session).results;
    for (const e of g.expect) {
      total++;
      const r = results.find((x) => e.title.test(x.ruleTitle));
      const got = r?.status ?? "MISSING";
      const ok = e.want === "not-fail" ? got !== "FAIL" && got !== "MISSING" : got === e.want;
      if (!ok) failures.push({ name: g.name, detail: `expected ${e.want}, got ${got}` });
    }
  }
  return { total, passed: total - failures.length, failures };
}

/** The human-facing selftest output. */
export function renderSelfTest(r: SelfTestResult): string {
  if (r.failures.length === 0) {
    return (
      `rulereceipt selftest\n\n` +
      `  ${r.total} checks, all correct.\n` +
      `  0 network calls — this ran entirely on your machine (watch it with lsof / Little Snitch if you like).\n\n` +
      `The same checkers ran here as on your real sessions. If any of these were ever wrong, this would say so.`
    );
  }
  const lines = r.failures.map((f) => `  ✗ ${f.name} — ${f.detail}`);
  return `rulereceipt selftest\n\n  ${r.passed}/${r.total} correct, ${r.failures.length} WRONG:\n` + lines.join("\n") + `\n\nThis is a bug — please report it with the version (rulereceipt --version).`;
}
