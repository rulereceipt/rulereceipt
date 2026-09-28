import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRules } from "../src/rules.js";

/**
 * .agents/rules/*.md is loaded by the agent only when its `trigger:` says the
 * agent auto-loads it. A manual/model_decision file is NOT auto-loaded, so
 * checking the session against it would be a false accusation — those are
 * skipped. always_on / glob / no-trigger files are read. README is notes.
 */
describe(".agents/rules trigger awareness", () => {
  const dir = mkdtempSync(join(tmpdir(), "rr-agents-"));
  // a repo root so loadRules stops here and does not climb into $HOME rules
  writeFileSync(join(dir, ".git"), "");
  const rulesDir = join(dir, ".agents", "rules");
  mkdirSync(rulesDir, { recursive: true });

  writeFileSync(join(rulesDir, "always.md"), "---\ntrigger: always_on\n---\n- Never push to `main` directly\n");
  writeFileSync(join(rulesDir, "no-trigger.md"), "- Always run `npm test` before commit\n");
  writeFileSync(join(rulesDir, "globbed.md"), "---\ntrigger: glob\nglobs: src/*.ts\n---\n- Never use `any`\n");
  writeFileSync(join(rulesDir, "manual.md"), "---\ntrigger: manual\n---\n- Never delete the database\n");
  writeFileSync(join(rulesDir, "model.md"), "---\ntrigger: model_decision\n---\n- Prefer functional style\n");
  writeFileSync(join(rulesDir, "README.md"), "- These are our rules, do not treat as a rule\n");

  const rules = loadRules(dir);
  const titles = rules.map((r) => r.title);

  it("loads always_on, no-trigger and glob rule files", () => {
    expect(titles).toContain("Never push to `main` directly");
    expect(titles).toContain("Always run `npm test` before commit");
    expect(titles).toContain("Never use `any`");
  });

  it("skips manual and model_decision files — the agent never auto-loads them", () => {
    expect(titles).not.toContain("Never delete the database");
    expect(titles).not.toContain("Prefer functional style");
  });

  it("skips a README fragment in the rules directory", () => {
    expect(titles.some((t) => /do not treat as a rule/i.test(t))).toBe(false);
  });
});
