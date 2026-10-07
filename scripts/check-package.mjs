#!/usr/bin/env node
// Privacy/open-core guard: the published npm tarball may contain ONLY the
// built CLI (dist/) and the metadata/supply-chain files listed below. Anything
// else — corpus/, data/, local/, scripts/, tests/, fixtures/, CLAUDE.md,
// ACCOUNTS.md, CHANGELOG.md, a truth-set, team/cloud code — must never ship.
// The `files` whitelist in package.json enforces this today; this makes a
// regression a hard CI failure instead of a silent leak in a future release.
//
// Allowlist, not denylist: we assert what MAY ship, so a new private path is
// caught by default rather than needing to be predicted. THIRD_PARTY_LICENSES.txt
// and sbom.json are intentionally shipped (feat(supply-chain) 76409d0) and so
// are on the allowlist — keep this Set in sync with package.json `files`.
import { execSync } from "node:child_process";

const ALLOWED_TOP = new Set(["README.md", "LICENSE", "NOTICE.md", "package.json", "THIRD_PARTY_LICENSES.txt", "sbom.json"]);
const raw = execSync("npm pack --dry-run --json", { encoding: "utf-8" });
const files = JSON.parse(raw)[0].files.map((f) => f.path);

const forbidden = files.filter((p) => !(p.startsWith("dist/") || ALLOWED_TOP.has(p)));
if (forbidden.length > 0) {
  console.error("PACKAGE LEAK — these files would be published but are not allowed:");
  for (const p of forbidden) console.error("  " + p);
  console.error("\nOnly dist/ and " + [...ALLOWED_TOP].join("/") + " may ship.");
  process.exit(1);
}
console.log(`package clean: ${files.length} files, all under dist/ or metadata`);
