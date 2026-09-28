import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditProject, renderProjectAudit } from "../src/audit.js";

/**
 * audit v2 — the doorstep. Every fixture is a self-contained repo (a `.git`
 * marker stops the discovery walk there) and HOME is redirected to an empty
 * dir so the machine's real global ~/.claude rules can't leak into the counts
 * or the load graph — the same isolation the CLI smoke tests use.
 */
const realHome = process.env.HOME;
let emptyHome: string;

beforeAll(() => {
  emptyHome = mkdtempSync(join(tmpdir(), "rr-audit-home-"));
  process.env.HOME = emptyHome;
});
afterAll(() => {
  process.env.HOME = realHome;
  rmSync(emptyHome, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "rr-audit-"));
  writeFileSync(join(dir, ".git"), ""); // stop the walk here
  for (const [name, content] of Object.entries(files)) {
    const full = join(dir, name);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}
const ids = (dir: string) => auditProject(dir).diagnostics.map((d) => d.id);

describe("audit v2 doorstep", () => {
  it("empty repo: no rules file, empty load graph", () => {
    const dir = repo({});
    const a = auditProject(dir);
    expect(a.loadGraph).toEqual([]);
    expect(a.total).toBe(0);
    expect(ids(dir)).toContain("no-rules-file");
  });

  it("CLAUDE.md shadows AGENTS.md: AGENTS in graph as shadowed, diagnostic fires", () => {
    const dir = repo({
      "CLAUDE.md": "## 1. Never push to `main`\nNever push to `main`.\n",
      "AGENTS.md": "- Never delete `data/app.db`\n- Be nice\n",
    });
    const a = auditProject(dir);
    const agents = a.loadGraph.find((g) => g.path.endsWith("AGENTS.md"));
    expect(agents?.status).toBe("shadowed");
    expect(agents?.ruleCount).toBe(2); // 2 rules being ignored
    expect(ids(dir)).toContain("shadowed-file");
    // the loaded CLAUDE.md is NOT reported as shadowed
    expect(a.loadGraph.find((g) => g.path.endsWith("CLAUDE.md"))?.status).toBe("loaded");
  });

  it("docs-only handbook: docs-heavy diagnostic", () => {
    const dir = repo({
      "CLAUDE.md": ["# Handbook", "## A", "We value clarity.", "## B", "The API is in src.", "## C", "We are remote.", "## D", "Founded 2024.", "## E", "Read the wiki.", "## F", "We deploy on Vercel.", "## G", "Slack us.", "## H", "Be kind."].join("\n\n"),
    });
    expect(ids(dir)).toContain("docs-heavy");
  });

  it("pointer-only file: empty-or-pointer", () => {
    expect(ids(repo({ "CLAUDE.md": "See AGENTS.md for all rules.\n" }))).toContain("empty-or-pointer");
  });

  it("empty file: empty-or-pointer", () => {
    expect(ids(repo({ "CLAUDE.md": "" }))).toContain("empty-or-pointer");
  });

  it("leftover template text is flagged", () => {
    expect(ids(repo({ "CLAUDE.md": "## 1. Setup\nRun for [your project name].\nTODO: write the rule\n" }))).toContain("template-text");
  });

  it("broken @import flagged; email and npm scope are NOT", () => {
    const dir = repo({
      "CLAUDE.md": "## 1. Rule\nNever push to `main`.\n\nSee @./missing.md and @./AGENTS.md.\nContact security@example.com. Types from @types/node.\n",
      "AGENTS.md": "- x\n",
    });
    const msgs = auditProject(dir).diagnostics.filter((d) => d.id === "broken-import").map((d) => d.message);
    expect(msgs.join(" ")).toContain("@./missing.md");
    // false-positive guards: the existing import, the email, the npm scope
    expect(msgs.join(" ")).not.toContain("AGENTS.md");
    expect(msgs.join(" ")).not.toContain("example.com");
    expect(msgs.join(" ")).not.toContain("types/node");
  });

  it("large file: size-warn", () => {
    const big = "## 1. Rule\n" + "x".repeat(41000) + "\n";
    expect(ids(repo({ "CLAUDE.md": big }))).toContain("size-warn");
  });

  it("flags a hook wired under an unknown event name (it never fires)", () => {
    const dir = repo({ "CLAUDE.md": "- Never push to `main`\n", ".claude/settings.json": JSON.stringify({ hooks: { PreToolus: [{ hooks: [] }] } }) });
    expect(ids(dir)).toContain("hook-config");
  });

  it("does not flag a correctly-named hook", () => {
    const dir = repo({ "CLAUDE.md": "- Never push to `main`\n", ".claude/settings.json": JSON.stringify({ hooks: { PreToolUse: [{ hooks: [] }], Stop: [{ hooks: [] }] } }) });
    expect(ids(dir)).not.toContain("hook-config");
  });

  it("top fixes carry a stable handle for rules --include/--exclude", () => {
    const a = auditProject(repo({ "CLAUDE.md": "## 1. Deploy carefully\nNever deploy to production without a review.\n" }));
    const fix = a.topFixes[0];
    expect(fix).toBeDefined();
    expect(fix.handle).toMatch(/^[0-9a-f]{6,}$/);
  });

  it("--json shape carries loadGraph + diagnostics + counts", () => {
    const a = auditProject(repo({ "CLAUDE.md": "- Never run `git push --force`\n" }));
    expect(a).toHaveProperty("loadGraph");
    expect(a).toHaveProperty("diagnostics");
    expect(a).toHaveProperty("percentCheckable");
    expect(Array.isArray(a.loadGraph)).toBe(true);
  });

  it("render never says the model ignored a rule (audit can't know that)", () => {
    const out = renderProjectAudit(auditProject(repo({ "CLAUDE.md": "## 1. Rule\nNever push to `main`.\n", "AGENTS.md": "- x\n" })));
    expect(out.toLowerCase()).not.toMatch(/ignored your rule|claude ignored|didn't follow/);
    expect(out).toContain("Rules files found");
  });
});
