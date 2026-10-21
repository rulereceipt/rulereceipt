import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Minimal YAML-frontmatter reader (name + description are simple scalars) — avoids
// adding a dependency just for a test.
function frontmatter(src: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---/.exec(src);
  const out: Record<string, string> = {};
  if (!m) return out;
  for (const line of m[1].split("\n")) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
  }
  return out;
}

// We ship ONE skill in two copies: the canonical cross-agent copy at
// skills/rulereceipt/SKILL.md (consumed by .agents/skills, .claude/skills,
// .github/skills, `copilot skill add`, `npx skills`, OpenCode, Cursor, Devin)
// and the Claude Code plugin copy at plugin/skills/rulereceipt/SKILL.md.
// They must never drift, and the frontmatter must satisfy the open Agent Skills
// spec (name: lowercase/hyphen, <=64 chars, == dir name; description required, <=1024).
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const canonical = join(root, "skills/rulereceipt/SKILL.md");
const pluginCopy = join(root, "plugin/skills/rulereceipt/SKILL.md");

describe("rulereceipt skill — single source, spec-valid", () => {
  it("the canonical and plugin copies are byte-identical", () => {
    expect(readFileSync(pluginCopy, "utf8")).toBe(readFileSync(canonical, "utf8"));
  });

  it("frontmatter satisfies the Agent Skills open spec", () => {
    const data = frontmatter(readFileSync(canonical, "utf8"));
    expect(data.name).toBe("rulereceipt"); // == parent dir
    expect(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(data.name)).toBe(true);
    expect(data.name.length).toBeLessThanOrEqual(64);
    expect(typeof data.description).toBe("string");
    expect(data.description.length).toBeGreaterThan(0);
    expect(data.description.length).toBeLessThanOrEqual(1024);
  });

  it("the skill runs the read-only check, never --llm / hooks / a server", () => {
    const body = readFileSync(canonical, "utf8");
    expect(body).toContain("npx rulereceipt check");
    expect(body).toMatch(/Never pass `--llm`/);
    // explicitly forbids installing hooks / starting a server / uploading
    expect(body).toMatch(/Do not install hooks, start a server, or upload/);
  });
});
