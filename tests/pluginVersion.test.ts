import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The Claude Code plugin must call our CLI at an EXACT pinned version — never
 * @latest, never an unpinned `npx rulereceipt` that silently runs whatever is
 * newest. The pin has to track package.json, and plugin.json's own version has
 * to match the package too, so a `/plugin marketplace update` actually ships the
 * release the user installed. scripts/bump-plugin-version.mjs keeps both in step
 * on `npm version`; this test fails the moment they drift.
 */
const root = join(__dirname, "..");
const pkgVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version as string;
const pluginJson = JSON.parse(readFileSync(join(root, "plugin/.claude-plugin/plugin.json"), "utf8"));
const commandsDir = join(root, "plugin/commands");
const commandFiles = readdirSync(commandsDir).filter((f) => f.endsWith(".md"));

describe("plugin CLI version is pinned and in step with the package", () => {
  it("plugin.json version equals package.json version", () => {
    expect(pluginJson.version).toBe(pkgVersion);
  });

  it("every command pins the CLI to the exact package version", () => {
    for (const f of commandFiles) {
      const body = readFileSync(join(commandsDir, f), "utf8");
      if (!/rulereceipt/.test(body)) continue; // a command that doesn't call the CLI
      expect(body, `${f}: should invoke rulereceipt@${pkgVersion}`).toContain(`rulereceipt@${pkgVersion}`);
    }
  });

  it("no command uses @latest or an unpinned `npx rulereceipt`", () => {
    for (const f of commandFiles) {
      const body = readFileSync(join(commandsDir, f), "utf8");
      expect(body, `${f}: @latest is forbidden`).not.toMatch(/rulereceipt@latest/);
      // `npx rulereceipt` must always be followed by `@<version>` — never bare.
      expect(body, `${f}: unpinned "npx rulereceipt" is forbidden`).not.toMatch(/npx rulereceipt(?!@)/);
    }
  });
});
