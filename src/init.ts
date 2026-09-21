/**
 * `rulereceipt init` — a guided setup that tells you exactly where you are and
 * what to do next. Read-only on purpose: RuleReceipt audits OTHER tools for
 * silently writing to .claude/settings.json, so it will not do that itself.
 * It shows you the snippet to paste; you paste it.
 */

export interface InitState {
  hasClaudeMd: boolean;
  hasAgentsMd: boolean;
  hookInstalled: boolean;
  hasApiKey: boolean;
}

/** The PreToolUse guard hook, as it goes into .claude/settings.json. */
export const GUARD_HOOK_SNIPPET = `{
  "hooks": {
    "PreToolUse": [
      { "hooks": [ { "type": "command", "command": "rulereceipt guard" } ] }
    ]
  }
}`;

function line(done: boolean, label: string): string {
  return `  ${done ? "✓" : "✗"} ${label}`;
}

export function buildInitGuidance(state: InitState): string {
  const out: string[] = [];
  out.push("RuleReceipt setup");
  out.push("");
  out.push("Where you are:");
  out.push(line(state.hasClaudeMd || state.hasAgentsMd, "a rules file (CLAUDE.md or AGENTS.md) in this directory"));
  out.push(line(state.hookInstalled, "a RuleReceipt hook wired into Claude Code (enforcement)"));
  out.push(line(state.hasApiKey, "ANTHROPIC_API_KEY set (for rules that need judgment)"));
  out.push("");

  const steps: string[] = [];
  if (!state.hasClaudeMd && !state.hasAgentsMd) {
    steps.push(
      "Write a CLAUDE.md in this directory with your rules, one per line or per heading.\n" +
        '   Even a few lines work — e.g. "Never commit to main" and "Run the tests before committing".'
    );
  }
  if (!state.hookInstalled) {
    steps.push(
      "Turn on enforcement (optional but recommended). Add this to .claude/settings.json,\n" +
        "   then start a NEW Claude Code session so the hook loads:\n\n" +
        GUARD_HOOK_SNIPPET.split("\n").map((l) => `     ${l}`).join("\n") +
        "\n\n   It refuses a command that breaks a file/branch rule before it runs, and fails\n" +
        "   open on any error. Needs `npm i -g rulereceipt` (or use `npx rulereceipt guard`)."
    );
  }
  if (!state.hasApiKey) {
    steps.push(
      "Set ANTHROPIC_API_KEY (the same key Claude Code uses) if you want rules that need\n" +
        "   judgment graded. Without it those report UNCLEAR — deterministic checks run regardless,\n" +
        "   and nothing is ever sent without the --llm flag."
    );
  }

  if (steps.length === 0) {
    out.push("You're set up. Run:  rulereceipt check");
  } else {
    out.push("Next steps:");
    steps.forEach((s, i) => out.push(`${i + 1}. ${s}`));
  }
  out.push("");
  out.push("See it right now with no setup:  rulereceipt demo");
  out.push("Check your last real session:    rulereceipt check");
  return out.join("\n");
}
