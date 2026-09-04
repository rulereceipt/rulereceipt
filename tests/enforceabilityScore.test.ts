import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * The scorer must refuse to score a worksheet that does not match the sample
 * it was asked to draw.
 *
 * Found in use: running `--score` without repeating `--n 150` printed
 * "Sample: 100 drawn" above results computed from 150 labels. The percentages
 * happened to be right, but nothing anywhere checked that the labelled rules
 * were the drawn rules — and the population this samples from changes every
 * time the classifier does, so a redraw at the same seed can return an almost
 * entirely different set. A stale worksheet scored against a fresh draw
 * produces clean proportions and confidence intervals over rules nobody
 * looked at, which is the exact failure this measurement exists to avoid.
 */
const ROOT = resolve(__dirname, "..");
let dir: string;

function run(args: string[]): { out: string; code: number } {
  try {
    const out = execFileSync("npx", ["tsx", join(ROOT, "scripts", "enforceability-sample.ts"), ...args], {
      cwd: dir,
      encoding: "utf-8",
    });
    return { out, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { out: `${e.stdout ?? ""}${e.stderr ?? ""}`, code: e.status ?? 1 };
  }
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "rr-score-"));
  // A tiny corpus, so the draw is fast and fully controlled.
  const corpus = join(dir, "corpus");
  cpSync(join(ROOT, "tests", "fixtures"), corpus, { recursive: true });
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

// Each case spawns `npx tsx`, which resolves and compiles TypeScript from
// cold on a CI runner. Locally that is warm and takes about a second; in CI
// the same call ran past the 5s default and failed the 0.1.28 release. The
// tests are slow, not flaky — a generous ceiling is the honest fix, and
// lowering coverage to make the suite fast would be the wrong trade.
describe("enforceability scorer", { timeout: 120_000 }, () => {
  it("refuses to score a worksheet that doesn't match the drawn sample", () => {
    run(["corpus", "--n", "4", "--seed", "1"]);
    const ws = join(dir, "enforceability-worksheet.txt");
    expect(existsSync(ws)).toBe(true);
    // Label everything, then corrupt one rule's title so the worksheet no
    // longer describes the sample a fresh draw produces.
    let text = readFileSync(ws, "utf-8").replace(/^ANSWER:\s*$/gm, "ANSWER: p");
    text = text.replace(/^\[1\] .*/m, "[1] a rule that is not in the corpus at all");
    writeFileSync(ws, text);

    const { out, code } = run(["corpus", "--n", "4", "--seed", "1", "--score", "--by-model"]);
    expect(code).not.toBe(0);
    expect(out).toMatch(/does not match|mismatch/i);
  });

  it("never reports a sample size it did not actually score", () => {
    run(["corpus", "--n", "4", "--seed", "1"]);
    const ws = join(dir, "enforceability-worksheet.txt");
    writeFileSync(ws, readFileSync(ws, "utf-8").replace(/^ANSWER:\s*$/gm, "ANSWER: p"));
    // Omitting --n is how this was actually invoked. The default is 100, so
    // the header claimed a 100-rule sample above results from 4 labels.
    const { out } = run(["corpus", "--score", "--by-model"]);
    expect(out).not.toMatch(/Sample\s*:\s*100/);
  });

  it("scores cleanly when the worksheet does match the draw", () => {
    run(["corpus", "--n", "4", "--seed", "1"]);
    const ws = join(dir, "enforceability-worksheet.txt");
    writeFileSync(ws, readFileSync(ws, "utf-8").replace(/^ANSWER:\s*$/gm, "ANSWER: p"));
    const { out, code } = run(["corpus", "--n", "4", "--seed", "1", "--score", "--by-model"]);
    expect(code).toBe(0);
    expect(out).toMatch(/proseOnly\s+4\/4/);
  });

  it("does not false-positive on a title longer than the worksheet truncation", () => {
    // The writer truncates titles to 150 chars, which can land on a space;
    // the reader trims. Comparing one against the other reports a mismatch
    // between two strings that are the same rule. Caught in real use, missed
    // by the fixtures because their titles are short.
    // Character 149 must be a space, so slice(0,150) ends in one and trim()
    // removes it. That asymmetry is the whole bug.
    // Must contain a directive or the classifier files it as notARule and it
    // never enters the pool. "Never use " is 10 chars, so 139 x's put a space
    // at index 149 — exactly where slice(0,150) lands and trim() removes it.
    const long = `Never use ${"x".repeat(139)} and several more words after that`;
    writeFileSync(join(dir, "corpus", "LONGTITLE.md"), `## Rules\n\n- ${long}\n`);
    // n large enough that the long-titled rule is certainly in the sample.
    run(["corpus", "--n", "400", "--seed", "1"]);
    const ws = join(dir, "enforceability-worksheet.txt");
    writeFileSync(ws, readFileSync(ws, "utf-8").replace(/^ANSWER:\s*$/gm, "ANSWER: p"));
    const { out, code } = run(["corpus", "--n", "400", "--seed", "1", "--score", "--by-model"]);
    expect(out).not.toMatch(/does not match/i);
    expect(code).toBe(0);
  });
});
