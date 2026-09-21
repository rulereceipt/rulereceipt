import { describe, it, expect } from "vitest";
import { buildInitGuidance } from "../src/init.js";

describe("buildInitGuidance", () => {
  it("with nothing set up, lists all three next steps and the hook snippet", () => {
    const out = buildInitGuidance({ hasClaudeMd: false, hasAgentsMd: false, hookInstalled: false, hasApiKey: false });
    expect(out).toContain("✗ a rules file");
    expect(out).toContain("Next steps:");
    expect(out).toContain("CLAUDE.md");
    expect(out).toContain('"rulereceipt guard"'); // the hook snippet
    expect(out).toContain("ANTHROPIC_API_KEY");
  });

  it("with everything set up, says so and does not print next steps", () => {
    const out = buildInitGuidance({ hasClaudeMd: true, hasAgentsMd: false, hookInstalled: true, hasApiKey: true });
    expect(out).toContain("✓ a rules file");
    expect(out).toContain("You're set up");
    expect(out).not.toContain("Next steps:");
  });

  it("shows the hook snippet only when the hook is not installed", () => {
    const withHook = buildInitGuidance({ hasClaudeMd: true, hasAgentsMd: false, hookInstalled: true, hasApiKey: true });
    expect(withHook).not.toContain('"rulereceipt guard"');
    const noHook = buildInitGuidance({ hasClaudeMd: true, hasAgentsMd: false, hookInstalled: false, hasApiKey: true });
    expect(noHook).toContain('"rulereceipt guard"');
  });

  it("counts AGENTS.md as a rules file too", () => {
    const out = buildInitGuidance({ hasClaudeMd: false, hasAgentsMd: true, hookInstalled: false, hasApiKey: false });
    expect(out).toContain("✓ a rules file");
  });
});
