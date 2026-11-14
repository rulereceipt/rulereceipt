import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  agentCapabilities,
  agentsTableMarkdown,
  agentsTableRows,
  agentStatusLabel,
  AGENT_LABEL,
  supportedAgentCount,
} from "../src/capabilities.js";

// Anti-drift: the "Agent session support" tables published in the README and on
// the site homepage are GENERATED from the capability matrix (the same source as
// `doctor --capabilities`). These tests fail the moment a published table stops
// matching that source — e.g. an adapter is added/removed/renamed, or a status
// changes, and someone forgets to regenerate the docs. "Honest beats big": the
// docs cannot claim an agent the code can't read, or miss one it can.

const README = readFileSync(join(process.cwd(), "README.md"), "utf-8");
const SITE = readFileSync(join(process.cwd(), "landing", "index.html"), "utf-8");

const START = "<!-- agents-table:start -->";
const END = "<!-- agents-table:end -->";

function block(src: string): string {
  const i = src.indexOf(START);
  const j = src.indexOf(END);
  expect(i, "README/site is missing the agents-table:start marker").toBeGreaterThanOrEqual(0);
  expect(j, "README/site is missing the agents-table:end marker").toBeGreaterThan(i);
  // Drop a leading "GENERATED …" HTML guard comment so only the content is compared.
  return src.slice(i + START.length, j).replace(/^\s*<!--[\s\S]*?-->\s*/, "").trim();
}

describe("agents table is generated from the capability matrix", () => {
  it("every row has a display label (a new adapter must be named, not left as an id)", () => {
    for (const a of agentCapabilities()) {
      expect(AGENT_LABEL[a.tool], `no AGENT_LABEL for "${a.tool}"`).toBeTruthy();
    }
  });

  it("row set matches the capability matrix exactly — no extra, none missing", () => {
    expect(agentsTableRows().map((r) => r.tool)).toEqual(agentCapabilities().map((a) => a.tool));
  });

  it("status is derived from read/validated (bold only when actually supported)", () => {
    for (const r of agentsTableRows()) {
      const cap = agentCapabilities().find((a) => a.tool === r.tool)!;
      expect(r.status).toBe(agentStatusLabel(cap));
      expect(r.supported).toBe(cap.read !== "none");
    }
  });

  it("reports the real count of fully-validated agents (the '8 validated agents' headline)", () => {
    expect(supportedAgentCount()).toBe(agentCapabilities().filter((a) => a.read === "full" && a.validated).length);
  });
});

describe("README embeds the generated table verbatim", () => {
  it("the block between the markers equals agentsTableMarkdown()", () => {
    expect(block(README)).toBe(agentsTableMarkdown());
  });
});

describe("site homepage can't drift from the matrix", () => {
  const body = block(SITE);

  it("names every agent, with the same status word as doctor --capabilities", () => {
    for (const r of agentsTableRows()) {
      expect(body, `site is missing agent "${r.label}"`).toContain(r.label);
      expect(body, `site is missing status "${r.status}" for ${r.label}`).toContain(r.status);
    }
  });

  it("the hero line states the real supported-agent count", () => {
    // "Works with Claude Code, Codex, Cursor, Copilot CLI and N more"
    const named = 4;
    const more = supportedAgentCount() - named;
    expect(SITE, `hero line should say "and ${more} more"`).toContain(`and ${more} more`);
  });
});
