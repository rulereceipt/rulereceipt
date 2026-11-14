#!/usr/bin/env node
// Keep the Claude Code plugin in step with the npm package on every release:
//  - plugin/.claude-plugin/plugin.json `version` := package.json version
//  - every `npx rulereceipt[@x.y.z]` in plugin/commands/*.md is pinned to that
//    exact version (never @latest, never unpinned).
// Run automatically by the npm `version` lifecycle (so the bump lands in the
// version commit) and enforced by tests/pluginVersion.test.ts. Idempotent; safe
// to run by hand:  node scripts/bump-plugin-version.mjs
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
let changed = 0;

// 1) plugin.json version
const pluginJsonPath = join(root, "plugin/.claude-plugin/plugin.json");
const plugin = JSON.parse(readFileSync(pluginJsonPath, "utf8"));
if (plugin.version !== version) {
  plugin.version = version;
  writeFileSync(pluginJsonPath, JSON.stringify(plugin, null, 2) + "\n");
  console.log(`plugin.json version -> ${version}`);
  changed++;
}

// 2) pin every CLI invocation in the command files
const commandsDir = join(root, "plugin/commands");
const pin = /npx rulereceipt(?:@[0-9A-Za-z.\-]+)?/g;
for (const f of readdirSync(commandsDir).filter((x) => x.endsWith(".md"))) {
  const p = join(commandsDir, f);
  const before = readFileSync(p, "utf8");
  const after = before.replace(pin, `npx rulereceipt@${version}`);
  if (after !== before) {
    writeFileSync(p, after);
    console.log(`${f} -> rulereceipt@${version}`);
    changed++;
  }
}

if (changed === 0) console.log(`plugin already pinned to ${version} (no change).`);
