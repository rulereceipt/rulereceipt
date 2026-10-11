import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

/**
 * Hook stdin fuzz (correctness-program): the Stop hook reads whatever Claude
 * Code writes to its stdin and must ALWAYS fail open — allow the stop, exit 0,
 * emit valid JSON, and never emit a block — on any malformed, truncated, or
 * hostile payload. A hook that throws (or exits non-zero, or blocks) on bad
 * input would leave someone unable to end a session in their own editor, so
 * this is the one place the tool deliberately fails open; these cases hold it
 * to that. Drives the real built entry (dist/cli.js hook) over its real stdin.
 */
const CLI = resolve(__dirname, "..", "dist", "cli.js");

function runHookWith(input: string): { stdout: string; code: number } {
  try {
    const stdout = execFileSync("node", [CLI, "hook"], { input, encoding: "utf-8", timeout: 20000 });
    return { stdout, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; status?: number };
    return { stdout: e.stdout ?? "", code: typeof e.status === "number" ? e.status : -1 };
  }
}

// Small seeded PRNG (mulberry32) so the fuzz corpus is reproducible.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fuzzInputs(n: number): string[] {
  const rng = mulberry32(0x5eed);
  const chunks = ['{', '}', '[', ']', '"', ':', ',', '\\', '\n', '\u0000', 'transcript_path', 'cwd', 'stop_hook_active', 'true', 'null', '123', '😀', 'a'.repeat(50), '/no/such/file.jsonl'];
  const out: string[] = [
    "", " ", "\n", "not json at all", "{", "}", "[]", "null", "true", "123",
    '{"transcript_path":', '{"transcript_path":"/does/not/exist.jsonl"}',
    '{"stop_hook_active":true}', '{"cwd":12345}', '{"transcript_path":42}',
    '{"transcript_path":"' + "x".repeat(5000) + '"}',
    "\u0000\u0001\u0002", '{"a":{"a":{"a":{"a":{"a":1}}}}}',
  ];
  for (let i = 0; i < n; i++) {
    let s = "";
    const len = Math.floor(rng() * 40);
    for (let j = 0; j < len; j++) s += chunks[Math.floor(rng() * chunks.length)];
    out.push(s);
  }
  return out;
}

describe("hook stdin fuzz: always fails open, never throws, never blocks on bad input", () => {
  const inputs = fuzzInputs(45); // each case spawns a real `node … hook`; keep the count sane

  it("every malformed/random payload exits 0 with valid JSON and no block", () => {
    for (const input of inputs) {
      const { stdout, code } = runHookWith(input);
      expect(code, `exit code for input ${JSON.stringify(input.slice(0, 40))}`).toBe(0);
      // stdout must be exactly one valid JSON object (the hook's emit()).
      let parsed: unknown;
      expect(() => { parsed = JSON.parse(stdout.trim() || "{}"); }, `parse stdout for ${JSON.stringify(input.slice(0, 40))}`).not.toThrow();
      // Malformed/garbage input can never produce a block decision.
      expect((parsed as { decision?: string }).decision).not.toBe("block");
    }
  }, 120000);

  it("empty stdin allows the stop (emits {})", () => {
    const { stdout, code } = runHookWith("");
    expect(code).toBe(0);
    expect(JSON.parse(stdout.trim() || "{}")).toEqual({});
  });
});
