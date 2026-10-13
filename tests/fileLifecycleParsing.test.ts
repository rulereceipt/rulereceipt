import { describe, it, expect } from "vitest";
import { pathPattern, CD_INTO_TEMP, mutatesPathInBash, runFileLifecycleChecks } from "../src/checks/fileLifecycle.js";
import type { FileLifecycleClassification } from "../src/checks/classify.js";
import type { TranscriptEvent } from "../src/types.js";

const writeEv = (file_path: string, content = "x"): TranscriptEvent => ({ role: "assistant", kind: "tool_use", toolName: "Write", input: { file_path, content }, timestamp: "t" });
const bashEv = (command: string): TranscriptEvent => ({ role: "assistant", kind: "tool_use", toolName: "Bash", input: { command }, timestamp: "t" });
const forbid = (filePath: string): FileLifecycleClassification => ({ kind: "fileLifecycle", rule: { id: "1", title: "t", text: "t", source: "project" }, filePath, polarity: "forbid" });
const requireFile = (filePath: string): FileLifecycleClassification => ({ ...forbid(filePath), polarity: "require" });

/**
 * Direct unit coverage of fileLifecycle's Bash-mutation detection. The
 * end-to-end checker tests exercise these only through full classifications;
 * mutation testing showed the per-verb regex branches surviving. Behaviour-neutral
 * exports. The invariant throughout: a command that only READS the path, or only
 * NAMES it as an argument to something else, is never a mutation (no fabricated FAIL).
 */

describe("pathPattern", () => {
  const re = (fp: string) => new RegExp(pathPattern(fp));
  it("matches the path at a boundary (start, space, slash)", () => {
    expect(re("settings.json").test("cat settings.json")).toBe(true);
    expect(re("settings.json").test("settings.json")).toBe(true);
    expect(re(".claude/settings.json").test("/home/x/.claude/settings.json")).toBe(true);
  });
  it("does NOT match when the path is the tail of a longer filename", () => {
    expect(re("settings.json").test("other-settings.json")).toBe(false);
  });
  it("strips only a LEADING ./ (an interior /./ is kept)", () => {
    expect(re("src/./app.ts").test("rm src/./app.ts")).toBe(true);
  });
  it("does NOT match when followed by a non-boundary char (CHANGELOG.md vs CHANGELOG.mdx)", () => {
    expect(re("CHANGELOG.md").test("CHANGELOG.mdx")).toBe(false);
    expect(re("CHANGELOG.md").test("rm CHANGELOG.md")).toBe(true);
  });
  it("strips a leading ./ from the file path", () => {
    expect(re("./a.txt").test("rm a.txt")).toBe(true);
  });
});

describe("CD_INTO_TEMP", () => {
  it("matches cd into tmp / private tmp / var folders", () => {
    expect(CD_INTO_TEMP.test("cd /tmp && rm x")).toBe(true);
    expect(CD_INTO_TEMP.test("cd /private/tmp")).toBe(true);
    expect(CD_INTO_TEMP.test("cd /var/folders/ab/xyz")).toBe(true);
  });
  it("matches cd into a scratchpad / node_modules subtree", () => {
    expect(CD_INTO_TEMP.test("cd /home/u/scratchpad")).toBe(true);
    expect(CD_INTO_TEMP.test("cd project/node_modules")).toBe(true);
  });
  it("does NOT match cd into an ordinary project dir", () => {
    expect(CD_INTO_TEMP.test("cd /home/u/project")).toBe(false);
    expect(CD_INTO_TEMP.test("cd src")).toBe(false);
  });
  it("tolerates extra whitespace after cd (one-or-more, not exactly one)", () => {
    expect(CD_INTO_TEMP.test("cd  /tmp")).toBe(true);
    expect(CD_INTO_TEMP.test("cd   project/scratchpad")).toBe(true);
  });
});

describe("mutatesPathInBash: mutating verbs", () => {
  const F = "CHANGELOG.md";
  it("truncating/append redirect onto the path", () => {
    expect(mutatesPathInBash("echo x > CHANGELOG.md", F)).toBe(true);
    expect(mutatesPathInBash("echo x >> CHANGELOG.md", F)).toBe(true);
  });
  it("a redirect onto a DIFFERENT file whose name extends the path does not count", () => {
    expect(mutatesPathInBash("echo x > CHANGELOG.md.new", F)).toBe(false);
  });
  it("rm / rmdir / unlink of the path", () => {
    expect(mutatesPathInBash("rm CHANGELOG.md", F)).toBe(true);
    expect(mutatesPathInBash("unlink CHANGELOG.md", F)).toBe(true);
  });
  it("mv / cp ONTO the path (path is the destination, at end of segment)", () => {
    expect(mutatesPathInBash("mv tmp CHANGELOG.md", F)).toBe(true);
    expect(mutatesPathInBash("cp tmp CHANGELOG.md", F)).toBe(true);
  });
  it("mv FROM the path (path is the source, not the destination) is not a mutation of it", () => {
    expect(mutatesPathInBash("mv CHANGELOG.md backup", F)).toBe(false);
  });
  it("tee / truncate of the path", () => {
    expect(mutatesPathInBash("echo x | tee CHANGELOG.md", F)).toBe(true);
    expect(mutatesPathInBash("truncate -s 0 CHANGELOG.md", F)).toBe(true);
  });
  it("sed only mutates with an in-place flag", () => {
    expect(mutatesPathInBash("sed -i 's/a/b/' CHANGELOG.md", F)).toBe(true);
    expect(mutatesPathInBash("sed --in-place 's/a/b/' CHANGELOG.md", F)).toBe(true);
    expect(mutatesPathInBash("sed 's/a/b/' CHANGELOG.md", F)).toBe(false);
  });
});

describe("mutatesPathInBash: reads and mentions are NOT mutations", () => {
  const F = "CHANGELOG.md";
  it("cat / head / grep of the path", () => {
    expect(mutatesPathInBash("cat CHANGELOG.md", F)).toBe(false);
    expect(mutatesPathInBash("grep foo CHANGELOG.md", F)).toBe(false);
  });
  it("the path named inside a commit message is not mutated", () => {
    expect(mutatesPathInBash('git commit -m "update CHANGELOG.md"', F)).toBe(false);
  });
  it("the mutating verb must be the segment's own leading command", () => {
    // `rm` appears, but as an argument to echo, not as the command run.
    expect(mutatesPathInBash('echo "rm CHANGELOG.md"', F)).toBe(false);
  });
  it("finds the mutation when it is in a later segment of a chain", () => {
    expect(mutatesPathInBash("echo hi && rm CHANGELOG.md", F)).toBe(true);
  });
  it("a mutating VERB NAME as an argument to another command is not a mutation", () => {
    // Each guards the verb's own `exe === <verb> && <regex>` against being loosened
    // to `||`, which would fire on the verb name appearing anywhere.
    expect(mutatesPathInBash("echo rm CHANGELOG.md", F)).toBe(false);
    expect(mutatesPathInBash("echo tee CHANGELOG.md", F)).toBe(false);
    expect(mutatesPathInBash("echo truncate CHANGELOG.md", F)).toBe(false);
    expect(mutatesPathInBash("echo mv CHANGELOG.md", F)).toBe(false);
  });
});

describe("runFileLifecycleChecks: end-to-end verdicts", () => {
  it("forbid + a real in-project edit → FAIL, quoting the mutation", () => {
    const r = runFileLifecycleChecks([forbid("CHANGELOG.md")], [writeEv("CHANGELOG.md")])[0];
    expect(r.status).toBe("FAIL");
    expect(r.evidence).toContain("was actually modified");
  });
  it("forbid + an edit at a /tmp path → UNCLEAR, reported as outside the project (never FAIL)", () => {
    const r = runFileLifecycleChecks([forbid("CHANGELOG.md")], [writeEv("/tmp/probe/CHANGELOG.md")])[0];
    expect(r.status).toBe("UNCLEAR");
    expect(r.evidence).toContain("outside the project");
  });
  it("forbid + a Bash mutation after cd into tmp → outside the project, not a FAIL", () => {
    const r = runFileLifecycleChecks([forbid("CHANGELOG.md")], [bashEv("cd /tmp/x && rm CHANGELOG.md")])[0];
    expect(r.status).toBe("UNCLEAR");
    expect(r.evidence).toContain("outside the project");
  });
  it("forbid + only a read of the path → UNCLEAR / not_applicable, 'never written to'", () => {
    const r = runFileLifecycleChecks([forbid("CHANGELOG.md")], [bashEv("cat CHANGELOG.md")])[0];
    expect(r.status).toBe("UNCLEAR");
    expect(r.outcome).toBe("not_applicable");
    expect(r.evidence).toContain("never written to");
  });
  it("forbid + a Write whose file_path is not a string does not crash → UNCLEAR", () => {
    const ev = { role: "assistant", kind: "tool_use", toolName: "Write", input: { file_path: 123, content: "x" }, timestamp: "t" } as unknown as TranscriptEvent;
    const r = runFileLifecycleChecks([forbid("CHANGELOG.md")], [ev])[0];
    expect(r.status).toBe("UNCLEAR");
  });
  it("require + the file updated → PASS", () => {
    const r = runFileLifecycleChecks([requireFile("CHANGELOG.md")], [writeEv("CHANGELOG.md")])[0];
    expect(r.status).toBe("PASS");
    expect(r.evidence).toContain("updated as required");
  });
  it("require + the file never touched → UNCLEAR (not a fabricated FAIL)", () => {
    const r = runFileLifecycleChecks([requireFile("CHANGELOG.md")], [bashEv("echo hi")])[0];
    expect(r.status).toBe("UNCLEAR");
  });
});
