import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * One door to "Broken": a FAIL result may only be constructed in a reviewed
 * place. The whole product rests on never accusing wrongly, so a stray
 * `status: "FAIL"` in a new checker — the exact shape of an accidental false
 * accusation — must fail the build, not ship.
 *
 * `violation()` in types.ts is THE door: it can only be called from a
 * forbid-typed rule, so a require rule cannot produce a FAIL at all. The two
 * checkers below predate it; their FAILs are structured and reviewed but don't
 * fit violation()'s forbid-polarity signature (a claim-vs-evidence miss and an
 * edit-without-test miss are not "forbid" rules). The CLI file holds the `demo`
 * command's hardcoded sample output, which is illustration, not a verdict.
 *
 * Adding a file here is allowed but must be a deliberate decision — that review
 * is the point. A new checker should route its FAIL through violation() instead.
 * TODO(strict): move the `demo` sample data out of cli.ts and fold
 * claimEvidence/ifEditThenTest onto violation() so this list is just types.ts.
 */
const ALLOWED = new Set([
  "types.ts",
  join("checks", "claimEvidence.ts"),
  join("checks", "ifEditThenTest.ts"),
  "cli.ts",
]);

const FAIL_CONSTRUCTION = /status:\s*["']FAIL["']/;

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (name.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("one door to Broken", () => {
  const SRC = join(process.cwd(), "src");

  it("no source outside the reviewed allowlist constructs a FAIL result", () => {
    const offenders: string[] = [];
    for (const file of tsFiles(SRC)) {
      const rel = relative(SRC, file);
      if (ALLOWED.has(rel)) continue;
      if (FAIL_CONSTRUCTION.test(readFileSync(file, "utf-8"))) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it("the allowlist has no dead entries (every listed file still constructs a FAIL)", () => {
    for (const rel of ALLOWED) {
      const text = readFileSync(join(SRC, rel), "utf-8");
      expect(FAIL_CONSTRUCTION.test(text), `${rel} no longer constructs a FAIL — remove it from the allowlist`).toBe(true);
    }
  });
});
