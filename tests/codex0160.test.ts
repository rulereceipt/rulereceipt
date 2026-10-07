import { describe, it, expect } from "vitest";
import { parseCodexLine } from "../src/adapters/codex.js";

/**
 * Codex 0.160.1 "exec" custom tool. Verified against a real rollout
 * (2026-10-07): the agent's shell command and file edits are NOT structured
 * fields — they are embedded in a JAVASCRIPT HARNESS string sent as the tool
 * input, e.g. `const r = await tools.exec_command({cmd:"..."}); text(r.output);`
 * and `tools.apply_patch("*** Begin Patch\n*** Update File: ...")`. Before this,
 * a real `git push origin main` produced zero violations because the command
 * scanners only saw `const r = await tools.exec_command({cmd:...`.
 *
 * Fixtures below are redacted synthetic lines in that exact shape (generic
 * paths, no personal data).
 */
const customTool = (name: string, input: string, callId = "c1") =>
  JSON.stringify({
    timestamp: "2026-10-07T12:53:10Z",
    type: "response_item",
    payload: { type: "custom_tool_call", name, input, call_id: callId, status: "completed" },
  });

describe("Codex 0.160.1 exec harness", () => {
  it("extracts the real shell command from exec_command({cmd:...}), unescaping inner quotes", () => {
    // The commit message carries escaped quotes, exactly as the real rollout did.
    const js = 'const r = await tools.exec_command({cmd:"git add app.js && git commit -m \\"Add comment\\" && git push origin main","workdir":"/work","yield_time_ms":30000}); text(r.output);';
    const ev = parseCodexLine(customTool("exec", js));
    expect(ev).toHaveLength(1);
    expect(ev[0].kind).toBe("tool_use");
    expect(ev[0].toolName).toBe("Bash");
    expect((ev[0].input as { command: string }).command).toBe('git add app.js && git commit -m "Add comment" && git push origin main');
  });

  it("turns apply_patch Update File into an Edit with the file path", () => {
    const js = 'const patch = "*** Begin Patch\\n*** Update File: /work/app.js\\n@@\\n+// hi\\n console.log(\\"hi\\")\\n*** End Patch";\ntext(await tools.apply_patch(patch));';
    const ev = parseCodexLine(customTool("exec", js));
    expect(ev).toHaveLength(1);
    expect(ev[0].toolName).toBe("Edit");
    expect((ev[0].input as { file_path: string }).file_path).toBe("/work/app.js");
  });

  it("maps Add File to Write and Delete File to an rm command", () => {
    const add = parseCodexLine(customTool("exec", 'tools.apply_patch("*** Begin Patch\\n*** Add File: /work/new.ts\\n+x\\n*** End Patch")'));
    expect(add[0].toolName).toBe("Write");
    expect((add[0].input as { file_path: string }).file_path).toBe("/work/new.ts");

    const del = parseCodexLine(customTool("exec", 'tools.apply_patch("*** Begin Patch\\n*** Delete File: /work/old.ts\\n*** End Patch")'));
    expect(del[0].toolName).toBe("Bash");
    expect((del[0].input as { command: string }).command).toContain("rm -- /work/old.ts");
  });

  it("detects a push to main that is buried in the harness (the bug this fixes)", () => {
    const js = 'const r = await tools.exec_command({cmd:"git push origin main","workdir":"/work"}); text(r.output);';
    const ev = parseCodexLine(customTool("exec", js));
    expect((ev[0].input as { command: string }).command).toBe("git push origin main");
  });

  it("does not misfire on a non-harness custom tool (regression)", () => {
    // A plain custom tool whose input is ordinary JSON must still parse normally.
    const ev = parseCodexLine(
      JSON.stringify({
        timestamp: "t",
        type: "response_item",
        payload: { type: "custom_tool_call", name: "lookup", input: JSON.stringify({ query: "weather" }), call_id: "c2" },
      })
    );
    expect(ev).toHaveLength(1);
    expect(ev[0].toolName).toBe("lookup");
  });
});
