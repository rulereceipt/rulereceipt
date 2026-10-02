import { defineConfig, configDefaults } from "vitest/config";

/**
 * Keep vitest's default include/exclude, but also ignore `.claude/` — an
 * isolated agent worktree lives at `.claude/worktrees/<id>/` and is a full copy
 * of the repo, tests and all. Without this, a worktree present during a local
 * run doubles the test count and reports its (un-built, no-dist) copies as
 * failures. CI is unaffected (it checks out clean), but local release gating
 * must see only the real tree.
 */
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "**/.claude/**"],
  },
});
