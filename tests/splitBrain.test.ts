import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Rule } from "../src/types.js";

const claudeRule: Rule = { id: "1", title: "No direct commits to main", text: "Never commit directly to main; always use a PR.", source: "project" };
const agentsRule: Rule = { id: "1", title: "Hotfix rule", text: "For urgent hotfixes, commit directly to main to save time.", source: "project" };
const unrelatedAgentsRule: Rule = { id: "2", title: "Test coverage", text: "Every new function needs a test.", source: "project" };

describe("findSplitBrainConflicts — no API key / missing input paths", () => {
  const originalKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    if (originalKey) process.env.ANTHROPIC_API_KEY = originalKey;
  });

  it("does not run and says why when either file has zero rules", async () => {
    const { findSplitBrainConflicts } = await import("../src/checks/splitBrain.js");
    const result = await findSplitBrainConflicts([], [agentsRule]);
    expect(result.ran).toBe(false);
    expect(result.conflicts).toEqual([]);
    expect(result.reason).toContain("CLAUDE.md and an AGENTS.md");
  });

  it("does not run and says why when no API key is set, never claims 'no conflicts' silently", async () => {
    const { findSplitBrainConflicts } = await import("../src/checks/splitBrain.js");
    const result = await findSplitBrainConflicts([claudeRule], [agentsRule]);
    expect(result.ran).toBe(false);
    expect(result.reason).toContain("ANTHROPIC_API_KEY");
    expect(result.conflicts).toEqual([]);
  });
});

describe("findSplitBrainConflicts — API interaction (mocked)", () => {
  const originalKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-key-for-mocked-tests-only";
    vi.resetModules();
  });

  afterEach(() => {
    if (originalKey) process.env.ANTHROPIC_API_KEY = originalKey;
    else delete process.env.ANTHROPIC_API_KEY;
    vi.doUnmock("@anthropic-ai/sdk");
  });

  it("reports a real contradiction the model found, mapped back to the actual rules", async () => {
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class MockAnthropic {
        messages = {
          create: vi.fn().mockResolvedValue({
            content: [
              {
                type: "tool_use",
                input: {
                  conflicts: [
                    {
                      claudeMdRuleId: "1",
                      agentsMdRuleId: "1",
                      explanation: "CLAUDE.md forbids direct commits to main; AGENTS.md tells the agent to commit directly to main for hotfixes.",
                    },
                  ],
                },
              },
            ],
          }),
        };
      },
    }));
    const { findSplitBrainConflicts } = await import("../src/checks/splitBrain.js");
    const result = await findSplitBrainConflicts([claudeRule], [agentsRule]);
    expect(result.ran).toBe(true);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].claudeMdRule.title).toBe("No direct commits to main");
    expect(result.conflicts[0].agentsMdRule.title).toBe("Hotfix rule");
  });

  it("returns zero conflicts, ran=true, when the model correctly finds none", async () => {
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class MockAnthropic {
        messages = {
          create: vi.fn().mockResolvedValue({ content: [{ type: "tool_use", input: { conflicts: [] } }] }),
        };
      },
    }));
    const { findSplitBrainConflicts } = await import("../src/checks/splitBrain.js");
    const result = await findSplitBrainConflicts([claudeRule], [unrelatedAgentsRule]);
    expect(result.ran).toBe(true);
    expect(result.conflicts).toEqual([]);
  });

  it("fails closed (ran: false) if the API call throws, never silently reports zero conflicts", async () => {
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class MockAnthropic {
        messages = { create: vi.fn().mockRejectedValue(new Error("rate limited")) };
      },
    }));
    const { findSplitBrainConflicts } = await import("../src/checks/splitBrain.js");
    const result = await findSplitBrainConflicts([claudeRule], [agentsRule]);
    expect(result.ran).toBe(false);
    expect(result.reason).toContain("rate limited");
  });

  // proves this test can fail: a conflict referencing a rule id that doesn't
  // actually exist in the input must be dropped, not fabricated into the output
  it("drops a conflict that references a rule id not present in the real input", async () => {
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class MockAnthropic {
        messages = {
          create: vi.fn().mockResolvedValue({
            content: [
              { type: "tool_use", input: { conflicts: [{ claudeMdRuleId: "999", agentsMdRuleId: "1", explanation: "x" }] } },
            ],
          }),
        };
      },
    }));
    const { findSplitBrainConflicts } = await import("../src/checks/splitBrain.js");
    const result = await findSplitBrainConflicts([claudeRule], [agentsRule]);
    expect(result.conflicts).toEqual([]);
  });
});
