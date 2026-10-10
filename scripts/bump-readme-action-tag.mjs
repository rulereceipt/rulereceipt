#!/usr/bin/env node
// Keep the README's GitHub Action example pinned to the current package.json
// version: `uses: rulereceipt/rulereceipt@vX.Y.Z`. A published Action example on
// @main (or a stale tag) tells people to run code that isn't the release they
// installed. Run automatically by the npm `version` lifecycle script (so the bump
// lands in the version commit), and enforced by a gate check in
// validate-release.sh. Idempotent; safe to run by hand:  node scripts/bump-readme-action-tag.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const readmePath = join(root, "README.md");
const before = readFileSync(readmePath, "utf8");

// Only the Action reference (owner/repo@vX.Y.Z). Never touches other version
// strings in the README (badges, "tested on", changelog-style lines).
const re = /rulereceipt\/rulereceipt@v\d+\.\d+\.\d+/g;
const after = before.replace(re, `rulereceipt/rulereceipt@v${version}`);

if (after === before) {
  console.log(`README Action tag already at v${version} (no change).`);
  process.exit(0);
}
writeFileSync(readmePath, after);
console.log(`README Action tag -> v${version}.`);
