#!/usr/bin/env node
/**
 * Licence gate: fail the build if any PRODUCTION dependency carries a licence
 * outside the permissive allow-list, or any LicenseRef-* / custom licence (e.g.
 * the "MIT + OpenAI/Anthropic Rider" family, or AGPL/GPL). Keeps a source-available
 * product that we may one day sell free of viral or acquisition-blocking terms.
 *
 * Self-contained: reads licences from node_modules/<pkg>/package.json. No network,
 * no extra dependency. Run after `npm ci`.
 */
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";

const ALLOW = new Set([
  "MIT", "MIT-0", "ISC", "0BSD", "BSD-2-Clause", "BSD-3-Clause",
  "Apache-2.0", "BlueOak-1.0.0", "Python-2.0", "Unlicense", "CC0-1.0",
]);

function licenseOf(pkgJson) {
  let lic = pkgJson.license ?? (Array.isArray(pkgJson.licenses) ? pkgJson.licenses.map((l) => l.type || l).join(" OR ") : undefined);
  if (lic && typeof lic === "object") lic = lic.type;
  return String(lic ?? "UNKNOWN");
}

/** An SPDX expression is OK when at least one OR-option is allow-listed and nothing is a red flag. */
function isAllowed(expr) {
  if (/LicenseRef|AGPL|(^|[^L])GPL/i.test(expr)) return false; // reject rider/custom + copyleft (LGPL still needs review -> not here)
  return expr
    .split(/\s+OR\s+|\//)
    .map((x) => x.replace(/[()]/g, "").trim())
    .some((x) => ALLOW.has(x));
}

// Production dependency names (npm ls exits non-zero on warnings; read its stdout anyway).
let tree = {};
try {
  tree = JSON.parse(execSync("npm ls --omit=dev --all --json", { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }));
} catch (e) {
  try { tree = JSON.parse(e.stdout || "{}"); } catch { tree = {}; }
}
const names = new Set();
(function walk(node) {
  for (const [name, child] of Object.entries(node.dependencies ?? {})) {
    names.add(name);
    walk(child);
  }
})(tree);

const bad = [];
for (const name of names) {
  const pj = `node_modules/${name}/package.json`;
  if (!existsSync(pj)) continue;
  const expr = licenseOf(JSON.parse(readFileSync(pj, "utf-8")));
  if (!isAllowed(expr)) bad.push(`${name}: ${expr}`);
}

if (bad.length > 0) {
  console.error("Licence gate FAILED — these production dependencies are not permissively licensed:");
  for (const b of bad) console.error("  " + b);
  console.error("\nAllowed: " + [...ALLOW].join(", ") + ". LicenseRef-*, AGPL and GPL are rejected.");
  process.exit(1);
}
console.log(`Licence gate OK — ${names.size} production dependenc${names.size === 1 ? "y" : "ies"}, all permissively licensed.`);
