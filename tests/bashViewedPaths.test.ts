import { describe, it, expect } from "vitest";
import {
  bashViewedPaths,
  loadModeForVersion,
  cmpVersion,
  claudeCodeVersionFromTranscript,
} from "../src/checks/pathScope.js";
import type { TranscriptEvent } from "../src/types.js";

/**
 * Version-gated Bash-read loading model (anthropics/claude-code#90450).
 *
 * Each row below is a line from yishait-tailor's measured 2.1.296 table (via an
 * InstructionsLoaded ground-truth hook). These feed the ADVISORY
 * `edited-rule-not-loaded` shadow signal only — never a verdict — but they must
 * still match the real per-version behaviour. See pathScope.bashViewedPaths.
 */

const t = "2026-10-14T00:00:00Z";
const bash = (c: string): TranscriptEvent => ({ role: "assistant", kind: "tool_use", toolName: "Bash", input: { command: c }, timestamp: t });
const viewed = (cmd: string, version?: string) => bashViewedPaths([bash(cmd)], version);

describe("cmpVersion / loadModeForVersion / version extraction", () => {
  it("compares versions numerically, not lexically", () => {
    expect(cmpVersion("2.1.9", "2.1.10")).toBe(-1); // lexical would say 9 > 10
    expect(cmpVersion("2.1.296", "2.1.296")).toBe(0);
    expect(cmpVersion("2.1.300", "2.1.296")).toBe(1);
  });
  it("maps each version band to its load model", () => {
    expect(loadModeForVersion("2.1.288")).toBe("none");
    expect(loadModeForVersion("2.1.292")).toBe("none");
    expect(loadModeForVersion("2.1.293")).toBe("legacy");
    expect(loadModeForVersion("2.1.295")).toBe("legacy");
    expect(loadModeForVersion("2.1.296")).toBe("refined");
    expect(loadModeForVersion("2.1.299")).toBe("refined");
    expect(loadModeForVersion(undefined)).toBe("legacy"); // non-regressing fallback
  });
  it("reads the highest version recorded in the raw transcript", () => {
    const text = '{"type":"x","version":"2.1.293"}\n{"type":"y","version":"2.1.296"}\n{"type":"z"}';
    expect(claudeCodeVersionFromTranscript(text)).toBe("2.1.296");
    expect(claudeCodeVersionFromTranscript(undefined)).toBeUndefined();
    expect(claudeCodeVersionFromTranscript('{"no":"version"}')).toBeUndefined();
  });
});

describe("< 2.1.293: a Bash read loads nothing", () => {
  it("even a plain cat loads no nested rule", () => {
    expect(viewed("cat /abs/db/schema.sql", "2.1.288")).toEqual([]);
  });
});

describe("2.1.293 .. < 2.1.296 (legacy) and unknown version", () => {
  for (const v of ["2.1.293", "2.1.295", undefined] as const) {
    const label = v ?? "unknown";
    it(`[${label}] a plain single-file reader loads`, () => {
      expect(viewed("cat /abs/db/schema.sql", v)).toEqual(["/abs/db/schema.sql"]);
      expect(viewed("less /abs/x.txt", v)).toEqual(["/abs/x.txt"]); // less/more still count in legacy
    });
    it(`[${label}] a pipe/chain loads nothing (legacy rejects ; and &&)`, () => {
      expect(viewed("cat /abs/a | head -5", v)).toEqual([]);
      expect(viewed("cat /abs/a; cat /abs/b", v)).toEqual([]);
    });
    it(`[${label}] legacy is permissive about extra flags`, () => {
      expect(viewed("cat -A /abs/a", v)).toEqual(["/abs/a"]); // refined would drop this
    });
  }
});

describe(">= 2.1.296 (refined) — LOADS", () => {
  const V = "2.1.296";
  it("plain single-file cat/head/tail/nl/bat", () => {
    expect(viewed("cat /abs/db/schema.sql", V)).toEqual(["/abs/db/schema.sql"]);
    expect(viewed("head -5 /abs/x.go", V)).toEqual(["/abs/x.go"]);
    expect(viewed("head -n 5 /abs/x.go", V)).toEqual(["/abs/x.go"]);
    expect(viewed("tail -n 3 /abs/x.go", V)).toEqual(["/abs/x.go"]);
    expect(viewed("nl /abs/x.txt", V)).toEqual(["/abs/x.txt"]);
    expect(viewed("bat /abs/x.rs", V)).toEqual(["/abs/x.rs"]);
  });
  it("sed -n and non-recursive grep/rg with a match", () => {
    expect(viewed("sed -n '1,5p' /abs/x.sql", V)).toEqual(["/abs/x.sql"]);
    expect(viewed("grep -n PRODUCT /abs/openapi/product.tsp", V)).toEqual(["/abs/openapi/product.tsp"]);
    expect(viewed("rg foo /abs/x.ts", V)).toEqual(["/abs/x.ts"]);
  });
  it("reads inside a ; or && list each count", () => {
    expect(viewed("cat /abs/a; cat /abs/b", V).sort()).toEqual(["/abs/a", "/abs/b"]);
    expect(viewed("head -1 /abs/a && tail -1 /abs/b", V).sort()).toEqual(["/abs/a", "/abs/b"]);
  });
});

describe(">= 2.1.296 (refined) — LOADS NOTHING", () => {
  const V = "2.1.296";
  it("pipes, ||, redirects (incl 2>/dev/null)", () => {
    expect(viewed("cat /abs/a | head -5", V)).toEqual([]);
    expect(viewed("cat /abs/a || true", V)).toEqual([]);
    expect(viewed("cat /abs/a 2>/dev/null", V)).toEqual([]);
    expect(viewed("cat /abs/a > /tmp/out", V)).toEqual([]);
  });
  it("extra flags (cat -A), and less/more are not refined readers", () => {
    expect(viewed("cat -A /abs/a", V)).toEqual([]);
    expect(viewed("less /abs/a", V)).toEqual([]);
    expect(viewed("more /abs/a", V)).toEqual([]);
  });
  it("cd dir && cat file loads nothing", () => {
    expect(viewed("cd /abs/front && cat index.html", V)).toEqual([]);
    expect(viewed("cd /abs/front; cat index.html", V)).toEqual([]);
  });
  it("grep -r and every Bash write load nothing", () => {
    expect(viewed("grep -r PATTERN /abs/dir", V)).toEqual([]);
    expect(viewed("grep -rn PATTERN /abs/dir", V)).toEqual([]);
    expect(viewed("sed -i s/a/b/ /abs/a", V)).toEqual([]); // write (no -n read form)
    expect(viewed("cp /abs/a /abs/b", V)).toEqual([]);
    expect(viewed("python -c 'print(1)' /abs/a", V)).toEqual([]);
    expect(viewed("echo hi > /abs/a", V)).toEqual([]);
  });
});
