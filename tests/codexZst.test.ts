import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as zlib from "node:zlib";
import { parseCodexTranscript, listCodexSessions } from "../src/adapters/codex.js";

/**
 * Compressed Codex rollouts. Once a session is compacted/paginated, Codex stores
 * it as `rollout-*.jsonl.zst` (Zstandard), not plain `.jsonl`. The adapter used
 * to match `.jsonl` only, so a current Codex user whose rollouts were compressed
 * saw "no Codex sessions found" (research 2026-10-03). Verified here that a
 * compressed rollout is discovered and decompresses to the SAME events as the
 * identical plain rollout.
 *
 * NOTE: synthetic fixture — no real personal Codex rollout exists on this
 * machine to validate against, so Codex staying experimental is unchanged.
 * Skipped on a Node without zstd (added in 22.15 / 23.8), which the adapter
 * also handles gracefully at runtime.
 */
const homeState = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => homeState.current || actual.homedir() };
});

const zstdCompressSync = (zlib as unknown as { zstdCompressSync?: (b: Buffer) => Buffer }).zstdCompressSync;
const hasZstd = typeof zstdCompressSync === "function";

const CWD = "/work/projectZ";
const ROLLOUT =
  JSON.stringify({ timestamp: "t", type: "session_meta", payload: { id: "1", cwd: CWD } }) + "\n" +
  JSON.stringify({ timestamp: "t", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] } }) + "\n";

describe.skipIf(!hasZstd)("Codex .jsonl.zst rollouts", () => {
  let home: string, day: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "rr-codex-zst-"));
    homeState.current = home;
    day = join(home, ".codex", "sessions", "2026", "03", "31");
    mkdirSync(day, { recursive: true });
    writeFileSync(join(day, "rollout-plain.jsonl"), ROLLOUT);
    writeFileSync(join(day, "rollout-comp.jsonl.zst"), zstdCompressSync!(Buffer.from(ROLLOUT)));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    homeState.current = "";
  });

  it("discovers a compressed rollout for the project (by its session_meta cwd)", () => {
    const found = listCodexSessions(CWD);
    expect(found.some((f) => f.endsWith("rollout-comp.jsonl.zst"))).toBe(true);
  });

  it("decompresses to the SAME events as the identical plain rollout", () => {
    const plain = parseCodexTranscript(join(day, "rollout-plain.jsonl"));
    const comp = parseCodexTranscript(join(day, "rollout-comp.jsonl.zst"));
    expect(comp.length).toBeGreaterThan(0);
    expect(comp).toEqual(plain);
    expect(comp.some((e) => e.kind === "text" && e.text === "hi")).toBe(true);
  });
});
