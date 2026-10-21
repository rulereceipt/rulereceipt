// Cross-surface count parity on REAL sessions (permanent gate, 2026-10-21).
// The four counts — followed / not followed / not visible / couldn't tell — must
// be identical across the surfaces a person actually reads. Any mismatch is a
// false accusation in one surface and the truth in another, and blocks release.
//
// This runs the shipped CLI end-to-end on the committed demo fixtures (terminal
// vs --json vs --html) and, when present, the local frozen-44 snapshot (terminal
// vs --json; the HTML/timeline/PR-comment surfaces are proven on every bucket,
// not-visible included, by tests/surfaceParity.test.ts in-process).
//
//   node scripts/surface-parity.mjs
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = process.cwd();
const CLI = join(REPO, "dist/cli.js");
const TMP = mkdtempSync(join(tmpdir(), "rr-parity-"));
const CI_HOME = mkdtempSync(join(tmpdir(), "rr-home-"));

function run(args, cwd) {
  try {
    return execFileSync("node", ["--max-old-space-size=8192", CLI, ...args], {
      cwd, encoding: "utf8", maxBuffer: 512 * 1024 * 1024,
      env: { ...process.env, HOME: CI_HOME, ANTHROPIC_API_KEY: "" },
    });
  } catch (e) {
    return e.stdout?.toString?.() ?? ""; // a FAIL exits non-zero but still prints
  }
}
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

// Parse "N followed · N not followed · [N rule not visible] · [N couldn't tell] · …"
function parseSummaryLine(text) {
  const g = (re) => { const m = re.exec(text); return m ? Number(m[1]) : 0; };
  return {
    followed: g(/(\d+) followed/),
    notFollowed: g(/(\d+) not followed/),
    notVisible: g(/(\d+) rule[s]? not visible/),
    couldntTell: g(/(\d+) couldn(?:'|&#39;)t tell/),
  };
}
function fromJson(stdout) {
  const s = JSON.parse(stdout).summary;
  return { followed: s.pass, notFollowed: s.fail, notVisible: s.ruleNotVisible, couldntTell: s.couldntTell };
}
const eq = (a, b) => a.followed === b.followed && a.notFollowed === b.notFollowed && a.notVisible === b.notVisible && a.couldntTell === b.couldntTell;
const fmt = (c) => `f=${c.followed} nf=${c.notFollowed} nv=${c.notVisible} ct=${c.couldntTell}`;

const mismatches = [];
let checked = 0;

function checkSession(label, cwd, transcript, withHtml) {
  const surfaces = {};
  surfaces.json = fromJson(run(["check", "--transcript", transcript, "--json"], cwd));
  surfaces.terminal = parseSummaryLine(strip(run(["check", "--transcript", transcript], cwd)));
  if (withHtml) {
    const out = join(TMP, "r.html");
    run(["check", "--transcript", transcript, "--html", out], cwd);
    surfaces.html = parseSummaryLine(existsSync(out) ? readFileSync(out, "utf8") : "");
  }
  const ref = surfaces.json;
  for (const [name, c] of Object.entries(surfaces)) {
    if (!eq(ref, c)) mismatches.push(`${label}: ${name} (${fmt(c)}) != json (${fmt(ref)})`);
  }
  checked++;
}

// 1) demo project — materialized in a temp dir at runtime, NOT committed as
// CLAUDE.md (a committed nested CLAUDE.md under tests/ would be discovered as the
// repo's OWN rules when checking from the repo root, polluting self-checks and the
// frozen diff). Exercises not-visible (compacted, never-loaded) and a plain FAIL.
const FX = join(TMP, "web-api");
mkdirSync(join(FX, "src/payments"), { recursive: true });
writeFileSync(join(FX, "CLAUDE.md"), "# web-api\n\n## 1. Run `npm test` before you push\n");
writeFileSync(join(FX, "src/payments/CLAUDE.md"), "# payments (path-scoped)\n\n## 1. Never edit files under `src/payments/` without approval\n");
writeFileSync(join(FX, "src/payments/charge.ts"), "export function charge(cents){ return cents; }\n");
const NEVER = `{"type":"user","version":"2.1.288","message":{"role":"user","content":[{"type":"text","text":"<system-reminder>\\nContents of /abs/web-api/CLAUDE.md (project instructions, checked into the codebase):\\n\\n# web-api\\n\\n## 1. Run \`npm test\` before you push\\n</system-reminder>\\n\\nStart the billing refactor."}]}}
{"type":"user","version":"2.1.288","isCompactSummary":true,"message":{"role":"user","content":[{"type":"text","text":"[conversation compacted] continue with the charge module."}]}}
{"type":"assistant","version":"2.1.288","message":{"role":"assistant","content":[{"type":"tool_use","name":"Edit","input":{"file_path":"src/payments/charge.ts","old_string":"return cents;","new_string":"return cents * 1.0;"}}]}}`;
const LOADED = `{"type":"user","version":"2.1.296","message":{"role":"user","content":[{"type":"text","text":"<system-reminder>\\nContents of /abs/web-api/CLAUDE.md (project instructions, checked into the codebase):\\n\\n# web-api\\n</system-reminder>\\n\\nUpdate the charge amount."}]}}
{"type":"assistant","version":"2.1.296","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","input":{"command":"cat src/payments/CLAUDE.md"}}]}}
{"type":"assistant","version":"2.1.296","message":{"role":"assistant","content":[{"type":"tool_use","name":"Edit","input":{"file_path":"src/payments/charge.ts","old_string":"return cents;","new_string":"return cents * 1.0;"}}]}}`;
writeFileSync(join(FX, "never-saw-it.jsonl"), NEVER + "\n");
writeFileSync(join(FX, "loaded.jsonl"), LOADED + "\n");
for (const t of ["never-saw-it.jsonl", "loaded.jsonl"]) {
  checkSession(`demo/${t}`, FX, join(FX, t), true);
}

// 2) frozen-44 (local, gitignored) — terminal vs json
const SNAP = join(REPO, "local/fa-private/snapshot");
if (existsSync(SNAP)) {
  for (const f of readdirSync(SNAP).filter((f) => f.endsWith(".jsonl")).sort()) {
    checkSession(`frozen/${f}`, REPO, join(SNAP, f), false);
  }
} else {
  console.log("(frozen-44 snapshot not present — demo fixtures only)");
}

if (mismatches.length > 0) {
  console.error(`SURFACE PARITY RED — ${mismatches.length} mismatch(es):`);
  for (const m of mismatches) console.error("  - " + m);
  process.exit(1);
}
console.log(`surface parity GREEN — ${checked} sessions, all surfaces agree on followed/not-followed/not-visible/couldn't-tell`);
