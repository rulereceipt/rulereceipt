import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, parse } from "node:path";

/**
 * An AGENTS.md that Claude Code never loads because a CLAUDE.md sits beside it.
 *
 * As of 2026-09-19, Claude Code reads AGENTS.md at a directory level ONLY when
 * that level has no CLAUDE.md; if both exist, the AGENTS.md is silently
 * ignored (InfoWorld / Enterprise DNA, 2026-09). So a rule a user carefully
 * wrote into AGENTS.md next to a CLAUDE.md governs nothing — Claude never saw
 * it.
 *
 * This matters to RuleReceipt in TWO ways:
 *   1. A warning the user needs: "these rules are dead, move them into
 *      CLAUDE.md." That is what this surfaces.
 *   2. A false-accusation risk in the tool itself: loadRules currently reads
 *      BOTH files, so it could report the session for breaking a shadowed
 *      AGENTS.md rule Claude never loaded. That deeper loading fix is tracked
 *      separately; this detector is the first, safe, additive step.
 *
 * Detection mirrors Claude Code's own precedence per directory level: a
 * CLAUDE.md shadows an AGENTS.md at the same level, and the same for the
 * `.claude/` subdirectory pair.
 */

export interface ShadowedAgents {
  /** The AGENTS.md that is being ignored. */
  agents: string;
  /** The CLAUDE.md at the same level that shadows it. */
  shadowedBy: string;
}

/** Directory-level pairs where a CLAUDE.md shadows an AGENTS.md. */
const SHADOW_PAIRS: { claude: string; agents: string }[] = [
  { claude: "CLAUDE.md", agents: "AGENTS.md" },
  { claude: join(".claude", "CLAUDE.md"), agents: join(".claude", "AGENTS.md") },
];

/**
 * Walks from cwd up to the repository root (inclusive), the same span
 * loadRules reads project rules over, and returns every AGENTS.md shadowed by
 * a CLAUDE.md. Global (home-dir) files are out of scope: that is a different
 * precedence and a different fix.
 */
export function shadowedAgentsMd(cwd: string): ShadowedAgents[] {
  const found: ShadowedAgents[] = [];
  const { root } = parse(cwd);
  const home = homedir();
  let dir = cwd;

  for (;;) {
    if (dir === home && dir !== cwd) break;
    for (const { claude, agents } of SHADOW_PAIRS) {
      const claudePath = join(dir, claude);
      const agentsPath = join(dir, agents);
      if (existsSync(claudePath) && existsSync(agentsPath)) {
        found.push({ agents: agentsPath, shadowedBy: claudePath });
      }
    }
    if (existsSync(join(dir, ".git"))) break;
    if (dir === root) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return found;
}
