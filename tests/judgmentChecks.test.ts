import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { JudgmentClassification } from "../src/checks/classify.js";

const rule: JudgmentClassification = {
  kind: "judgment",
  rule: { id: "4", title: "Surface bad news first", text: "Lead every report with what is broken.", source: "global" },
};

describe("runJudgmentChecks — no API key path (real, no mocking needed)", () => {
  const originalKey = process.env.ANTHROPIC_API_KEY;

  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    if (originalKey) process.env.ANTHROPIC_API_KEY = originalKey;
  });

  it("fails closed to UNCLEAR for every rule when no key is set, never PASS", async () => {
    const { runJudgmentChecks } = await import("../src/checks/judgmentChecks.js");
    const results = await runJudgmentChecks([rule], []);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("UNCLEAR");
  });

  it("gives an actionable evidence message, not a stack trace or blank string", async () => {
    const { runJudgmentChecks } = await import("../src/checks/judgmentChecks.js");
    const results = await runJudgmentChecks([rule], []);
    expect(results[0].evidence).toContain("ANTHROPIC_API_KEY");
  });

  it("returns an empty array for zero judgment rules, no API call attempted", async () => {
    const { runJudgmentChecks } = await import("../src/checks/judgmentChecks.js");
    const results = await runJudgmentChecks([], []);
    expect(results).toEqual([]);
  });
});

describe("runJudgmentChecks — API interaction (mocked, no live API key available in this environment)", () => {
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

  it("maps a well-formed structured response to the right rule", async () => {
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class MockAnthropic {
        messages = {
          create: vi.fn().mockResolvedValue({
            content: [
              {
                type: "tool_use",
                input: { results: [{ ruleId: "4", status: "FAIL", evidence: "led with good news, not bad" }] },
              },
            ],
          }),
        };
      },
    }));
    const { runJudgmentChecks } = await import("../src/checks/judgmentChecks.js");
    const results = await runJudgmentChecks([rule], []);
    expect(results[0]).toMatchObject({ ruleId: "4", status: "FAIL" });
  });

  it("fails closed to UNCLEAR if the API call throws", async () => {
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class MockAnthropic {
        messages = {
          create: vi.fn().mockRejectedValue(new Error("rate limited")),
        };
      },
    }));
    const { runJudgmentChecks } = await import("../src/checks/judgmentChecks.js");
    const results = await runJudgmentChecks([rule], []);
    expect(results[0].status).toBe("UNCLEAR");
    expect(results[0].evidence).toContain("rate limited");
  });

  it("fails closed to UNCLEAR if the model returns no tool_use block at all", async () => {
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class MockAnthropic {
        messages = {
          create: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "I refuse to use the tool." }] }),
        };
      },
    }));
    const { runJudgmentChecks } = await import("../src/checks/judgmentChecks.js");
    const results = await runJudgmentChecks([rule], []);
    expect(results[0].status).toBe("UNCLEAR");
  });

  // proves this test can fail: an invalid status value must not be trusted as-is
  it("does NOT accept a malformed status value as valid (sanity check)", async () => {
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class MockAnthropic {
        messages = {
          create: vi.fn().mockResolvedValue({
            content: [{ type: "tool_use", input: { results: [{ ruleId: "4", status: "MAYBE", evidence: "x" }] } }],
          }),
        };
      },
    }));
    const { runJudgmentChecks } = await import("../src/checks/judgmentChecks.js");
    const results = await runJudgmentChecks([rule], []);
    expect(results[0].status).toBe("UNCLEAR");
    expect(results[0].status).not.toBe("MAYBE");
  });
});
