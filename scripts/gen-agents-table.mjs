#!/usr/bin/env node
// Regenerate the "Agent session support" table embedded in README.md from the
// capability matrix (src/capabilities.ts → dist). The table is the published
// face of `rulereceipt doctor --capabilities`, so it must never be hand-edited
// away from the code: add/remove an adapter and run this. tests/agentsTable.test.ts
// fails if the committed README block drifts from what this would write.
// Requires a build first:  npm run build && node scripts/gen-agents-table.mjs
// (the `agents-table` npm script does both). Idempotent.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { agentsTableMarkdown } = await import(join(root, "dist", "capabilities.js"));

const START = "<!-- agents-table:start -->";
const END = "<!-- agents-table:end -->";
const GUARD =
  "<!-- GENERATED from src/capabilities.ts (agentsTableMarkdown()) — the same source as `rulereceipt doctor --capabilities`.\n" +
  "     Do not hand-edit: run `npm run agents-table` to regenerate. tests/agentsTable.test.ts fails if this drifts. -->";

const readmePath = join(root, "README.md");
const before = readFileSync(readmePath, "utf8");
const i = before.indexOf(START);
const j = before.indexOf(END);
if (i < 0 || j < 0 || j < i) {
  console.error("README is missing the agents-table markers — add them first.");
  process.exit(1);
}

const block = `${START}\n${GUARD}\n${agentsTableMarkdown()}\n${END}`;
const after = before.slice(0, i) + block + before.slice(j + END.length);
if (after === before) {
  console.log("README agents table already up to date (no change).");
  process.exit(0);
}
writeFileSync(readmePath, after);
console.log("README agents table regenerated.");
