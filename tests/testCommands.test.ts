import { describe, it, expect } from "vitest";
import { findTestRun } from "../src/checks/testCommands.js";
import type { TranscriptEvent } from "../src/types.js";

/**
 * A command that WRITES a test command is not a command that RUNS one.
 *
 * Found 2026-09-14 by running the published tool on a real session: two
 * false failures whose "last test run" was a shell variable assignment.
 * The real cause was a heredoc further down the same command, writing a
 * demo fixture whose body contains the string `npm test`. The literal was
 * being generated, not executed, and the tool then read its own report
 * output as the failing result.
 *
 * I attempted this fix once before and the fixture I invented did not
 * reproduce it, so the bug shipped. These use the real shape: a multi-line
 * command that sets up a temp directory and writes files with heredocs.
 */
const bash = (command: string): TranscriptEvent => ({
  role: "assistant", kind: "tool_use", toolName: "Bash", input: { command }, timestamp: "t",
});

describe("test-command detection ignores heredoc bodies", () => {
  it("does not treat a heredoc that writes 'npm test' as a test run", () => {
    const cmd = [
      'D=/private/tmp/claude-501/abc/scratchpad/ce',
      'rm -rf "$D" && mkdir -p "$D" && cd "$D"',
      "python3 - <<'PY'",
      "import json",
      'rows = [ a_tool("npm test"), u_res("Tests 1 failed", True) ]',
      'open("s.jsonl","w").write("\\n".join(json.dumps(r) for r in rows))',
      "PY",
      "node $CLI check --transcript s.jsonl",
    ].join("\n");
    expect(findTestRun([bash(cmd)])).toBeNull();
  });

  it("ignores an unquoted heredoc too", () => {
    const cmd = ["cat > demo.sh <<EOF", "npm test", "EOF", "echo done"].join("\n");
    expect(findTestRun([bash(cmd)])).toBeNull();
  });

  it("still sees a real test run in a multi-line command", () => {
    const cmd = ["cd /repo", "npm test"].join("\n");
    expect(findTestRun([bash(cmd)])).toBe(cmd);
  });

  it("still sees a real test run after a heredoc has closed", () => {
    const cmd = ["cat > fixture.txt <<'EOF'", "some content", "EOF", "npm test"].join("\n");
    expect(findTestRun([bash(cmd)])).toBe(cmd);
  });

  it("still sees a plain test command", () => {
    expect(findTestRun([bash("npm test")])).toBe("npm test");
  });
});
