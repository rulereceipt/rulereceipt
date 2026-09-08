import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { JudgmentClassification } from "../src/checks/classify.js";
import type { TranscriptEvent } from "../src/types.js";

/** The shape of a captured messages.create request, for asserting on it. */
interface CapturedCall {
  model?: string;
  tools?: unknown;
  system?: unknown;
  messages?: Array<{ role: string; content: unknown }>;
}

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
            content: [{ type: "tool_use", input: { status: "FAIL", evidence: "led with good news, not bad" } }],
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

  it("makes one isolated API call per rule, not one batched call for all rules", async () => {
    const create = vi.fn().mockResolvedValue({
      content: [{ type: "tool_use", input: { status: "PASS", evidence: "ok" } }],
    });
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class MockAnthropic {
        messages = { create };
      },
    }));
    const secondRule: JudgmentClassification = {
      kind: "judgment",
      rule: { id: "9", title: "Second rule", text: "another rule text", source: "global" },
    };
    const { runJudgmentChecks } = await import("../src/checks/judgmentChecks.js");
    await runJudgmentChecks([rule, secondRule], []);
    expect(create).toHaveBeenCalledTimes(2);
    // each call's prompt contains only its own rule's text, not the other rule's.
    // Content is a block array now (the transcript block carries the cache
    // marker and the rule block follows it), so flatten before asserting —
    // the isolation guarantee being checked here is unchanged.
    const textOf = (content: unknown): string =>
      Array.isArray(content) ? content.map((b: { text?: string }) => b.text ?? "").join("\n") : String(content);
    const firstCallContent = textOf(create.mock.calls[0][0].messages[0].content);
    const secondCallContent = textOf(create.mock.calls[1][0].messages[0].content);
    expect(firstCallContent).toContain("Surface bad news first");
    expect(firstCallContent).not.toContain("Second rule");
    expect(secondCallContent).toContain("Second rule");
    expect(secondCallContent).not.toContain("Surface bad news first");
  });

  // real bug the old batched design was exposed to: a project-level rule
  // can reuse the same number as a global one. The per-rule-call design
  // makes this structurally impossible (each result maps back to its own
  // rule by closure, not by matching a key in a shared response) — this
  // test locks that in as a regression check, not a live risk anymore.
  it("does NOT confuse two rules that share the same numeric id but different sources", async () => {
    const globalRule: JudgmentClassification = {
      kind: "judgment",
      rule: { id: "1", title: "Global one", text: "global text", source: "global" },
    };
    const projectRule: JudgmentClassification = {
      kind: "judgment",
      rule: { id: "1", title: "Project one", text: "project text", source: "project" },
    };
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class MockAnthropic {
        messages = {
          create: vi
            .fn()
            .mockResolvedValueOnce({ content: [{ type: "tool_use", input: { status: "PASS", evidence: "global evidence" } }] })
            .mockResolvedValueOnce({ content: [{ type: "tool_use", input: { status: "FAIL", evidence: "project evidence" } }] }),
        };
      },
    }));
    const { runJudgmentChecks } = await import("../src/checks/judgmentChecks.js");
    const results = await runJudgmentChecks([globalRule, projectRule], []);
    const global = results.find((r) => r.ruleSource === "global");
    const project = results.find((r) => r.ruleSource === "project");
    expect(global?.status).toBe("PASS");
    expect(project?.status).toBe("FAIL");
  });

  // proves this test can fail: an invalid status value must not be trusted as-is
  it("does NOT accept a malformed status value as valid (sanity check)", async () => {
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class MockAnthropic {
        messages = {
          create: vi.fn().mockResolvedValue({ content: [{ type: "tool_use", input: { status: "MAYBE", evidence: "x" } }] }),
        };
      },
    }));
    const { runJudgmentChecks } = await import("../src/checks/judgmentChecks.js");
    const results = await runJudgmentChecks([rule], []);
    expect(results[0].status).toBe("UNCLEAR");
    expect(results[0].status).not.toBe("MAYBE");
  });
});

/**
 * Six defects found by reading this file on 2026-09-08, all in the feature
 * that exists to answer the 55.8% of rules no deterministic check can reach.
 *
 * The worst of them is the bucket label. `needsHuman` was never set on any
 * result here, so every judgment rule ran through --llm landed in the
 * "Couldn't tell" bucket, which the report defines as "the tool looked and
 * the evidence was ambiguous". With no API key it looked at nothing and
 * still printed "13 couldn't tell". For a tool whose whole claim is that
 * its output can be trusted, reporting a check it never ran is the most
 * expensive bug it can have — and 167 lines of tests here never asserted
 * the field.
 */
describe("runJudgmentChecks — reports honestly which checks actually ran", () => {
  const originalKey = process.env.ANTHROPIC_API_KEY;
  beforeEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    vi.resetModules();
  });
  afterEach(() => {
    if (originalKey) process.env.ANTHROPIC_API_KEY = originalKey;
    else delete process.env.ANTHROPIC_API_KEY;
    vi.doUnmock("@anthropic-ai/sdk");
  });

  it("marks a rule it never examined as needing a human, not as 'couldn't tell'", async () => {
    const { runJudgmentChecks } = await import("../src/checks/judgmentChecks.js");
    const results = await runJudgmentChecks([rule], []);
    expect(results[0].needsHuman).toBe(true);
  });

  it("marks a rule whose API call failed as needing a human — the check did not run", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class {
        messages = { create: vi.fn().mockRejectedValue(new Error("boom")) };
      },
    }));
    const { runJudgmentChecks } = await import("../src/checks/judgmentChecks.js");
    const results = await runJudgmentChecks([rule], []);
    expect(results[0].status).toBe("UNCLEAR");
    expect(results[0].needsHuman).toBe(true);
  });

  it("does NOT mark a model-returned UNCLEAR as needing a human — that one was examined", async () => {
    // The distinction the two buckets exist for: the model read the session
    // and found it genuinely ambiguous. That is "couldn't tell", and
    // collapsing it into "needs your judgment" would be the same lie in the
    // other direction.
    process.env.ANTHROPIC_API_KEY = "test-key";
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class {
        messages = {
          create: vi.fn().mockResolvedValue({
            content: [{ type: "tool_use", input: { status: "UNCLEAR", evidence: "nothing in the session speaks to this" } }],
          }),
        };
      },
    }));
    const { runJudgmentChecks } = await import("../src/checks/judgmentChecks.js");
    const results = await runJudgmentChecks([rule], []);
    expect(results[0].status).toBe("UNCLEAR");
    expect(results[0].needsHuman).toBeFalsy();
  });
});

describe("runJudgmentChecks — what the model is actually shown", () => {
  const originalKey = process.env.ANTHROPIC_API_KEY;
  let calls: CapturedCall[];

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    calls = [];
    vi.resetModules();
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class {
        messages = {
          create: vi.fn().mockImplementation(async (req: CapturedCall) => {
            calls.push(req);
            return { content: [{ type: "tool_use", input: { status: "PASS", evidence: "quoted line" } }] };
          }),
        };
      },
    }));
  });
  afterEach(() => {
    if (originalKey) process.env.ANTHROPIC_API_KEY = originalKey;
    else delete process.env.ANTHROPIC_API_KEY;
    vi.doUnmock("@anthropic-ai/sdk");
  });

  function bigSession(marker: string, tailMarker: string) {
    const events: TranscriptEvent[] = [{ kind: "text", role: "user", text: marker }];
    for (let i = 0; i < 4000; i++) {
      events.push({ kind: "text", role: "assistant", text: `filler line ${i} ${"x".repeat(80)}` } as TranscriptEvent);
    }
    events.push({ kind: "text", role: "assistant", text: tailMarker } as TranscriptEvent);
    return events;
  }

  it("does not silently drop the start of a long session", async () => {
    // Keeping only the tail means a rule broken early and clean at the end
    // comes back PASS. That is a false PASS produced by truncation, which is
    // the exact failure the project's own postmortem is about.
    const { runJudgmentChecks } = await import("../src/checks/judgmentChecks.js");
    await runJudgmentChecks([rule], bigSession("EARLY_MARKER_ABC", "LATE_MARKER_XYZ"));
    const sent = JSON.stringify(calls[0]);
    expect(sent).toContain("LATE_MARKER_XYZ");
    expect(sent).toContain("EARLY_MARKER_ABC");
  });

  it("says so in the evidence when the session had to be truncated", async () => {
    // A verdict formed from a partial transcript must carry that fact, or a
    // PASS reads as if the whole session was examined.
    const { runJudgmentChecks } = await import("../src/checks/judgmentChecks.js");
    const results = await runJudgmentChecks([rule], bigSession("EARLY", "LATE"));
    expect(results[0].evidence).toMatch(/truncat|partial|not the whole/i);
  });

  it("leaves evidence untouched when nothing was truncated", async () => {
    const { runJudgmentChecks } = await import("../src/checks/judgmentChecks.js");
    const results = await runJudgmentChecks([rule], [{ kind: "text", role: "user", text: "short" }]);
    expect(results[0].evidence).toBe("quoted line");
  });

  it("asks for a verbatim quote, not a paraphrase", async () => {
    // The product promise is "with quoted evidence". A paraphrase cannot be
    // checked against the transcript, and this is the code path where a
    // fabricated line is most likely.
    const { runJudgmentChecks } = await import("../src/checks/judgmentChecks.js");
    await runJudgmentChecks([rule], []);
    const schema = JSON.stringify(calls[0].tools);
    expect(schema).not.toMatch(/paraphras/i);
    expect(schema).toMatch(/verbatim|exact/i);
  });

  it("uses a current model, not a superseded one", async () => {
    const { runJudgmentChecks } = await import("../src/checks/judgmentChecks.js");
    await runJudgmentChecks([rule], []);
    expect(calls[0].model).not.toMatch(/sonnet-4-5|claude-3/);
  });

  it("marks the shared transcript as cacheable, so N rules do not pay for N copies", async () => {
    // Every rule gets its own isolated call on purpose, and that is worth
    // keeping. But the transcript is byte-identical across all of them, so
    // without a cache marker a 13-rule file pays 13x for the same tokens.
    const { runJudgmentChecks } = await import("../src/checks/judgmentChecks.js");
    await runJudgmentChecks([rule], [{ kind: "text", role: "user", text: "hello" }]);
    expect(JSON.stringify(calls[0])).toMatch(/cache_control/);
  });

  it("caps how many calls are in flight at once", async () => {
    // Promise.all over every judgment rule means a 100-rule file opens 100
    // simultaneous requests, gets rate limited, and reports every rule as
    // UNCLEAR — which then displays as the tool being unsure rather than
    // throttled.
    let inFlight = 0;
    let peak = 0;
    vi.resetModules();
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class {
        messages = {
          create: vi.fn().mockImplementation(async () => {
            inFlight++;
            peak = Math.max(peak, inFlight);
            await new Promise((r) => setTimeout(r, 5));
            inFlight--;
            return { content: [{ type: "tool_use", input: { status: "PASS", evidence: "q" } }] };
          }),
        };
      },
    }));
    const { runJudgmentChecks } = await import("../src/checks/judgmentChecks.js");
    const many = Array.from({ length: 40 }, (_, i) => ({
      kind: "judgment" as const,
      rule: { id: String(i), title: `Rule ${i}`, text: "text", source: "global" as const },
    }));
    const results = await runJudgmentChecks(many, []);
    expect(results).toHaveLength(40);
    expect(peak).toBeLessThanOrEqual(8);
  });
});

describe("runJudgmentChecks — the model id can be overridden without a release", () => {
  const originalKey = process.env.ANTHROPIC_API_KEY;
  const originalModel = process.env.RULERECEIPT_MODEL;
  let calls: CapturedCall[];

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    calls = [];
    vi.resetModules();
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class {
        messages = {
          create: vi.fn().mockImplementation(async (req: CapturedCall) => {
            calls.push(req);
            return { content: [{ type: "tool_use", input: { status: "PASS", evidence: "q" } }] };
          }),
        };
      },
    }));
  });
  afterEach(() => {
    if (originalKey) process.env.ANTHROPIC_API_KEY = originalKey;
    else delete process.env.ANTHROPIC_API_KEY;
    if (originalModel) process.env.RULERECEIPT_MODEL = originalModel;
    else delete process.env.RULERECEIPT_MODEL;
    vi.doUnmock("@anthropic-ai/sdk");
  });

  it("uses RULERECEIPT_MODEL when set", async () => {
    // A hardcoded model id means every future model change needs a release,
    // and a wrong one breaks --llm for everybody until that release ships.
    process.env.RULERECEIPT_MODEL = "some-other-model";
    const { runJudgmentChecks } = await import("../src/checks/judgmentChecks.js");
    await runJudgmentChecks([rule], []);
    expect(calls[0].model).toBe("some-other-model");
  });

  it("falls back to the built-in default when the variable is empty", async () => {
    process.env.RULERECEIPT_MODEL = "";
    const { runJudgmentChecks } = await import("../src/checks/judgmentChecks.js");
    await runJudgmentChecks([rule], []);
    expect(calls[0].model).toBeTruthy();
    expect(calls[0].model).not.toBe("");
  });
});
