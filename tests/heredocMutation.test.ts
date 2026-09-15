import { describe, it, expect } from "vitest";
import { runFileLifecycleChecks } from "../src/checks/fileLifecycle.js";
import type { FileLifecycleClassification } from "../src/checks/classify.js";
import type { TranscriptEvent } from "../src/types.js";

/**
 * A path named only inside a heredoc body was not touched by the command
 * that contains it.
 *
 * VERBATIM from a real session, found 2026-09-15 in the corpus measurement.
 * The command edits landing/index.html through a Python heredoc; the HTML it
 * inserts happens to contain the string ".claude/settings.json" because the
 * page tells readers where to put a hook. The checker reported that the
 * session had modified ".claude/" - a protected path in several corpus rules.
 *
 * The heredoc guard already existed. It was written for test-command
 * detection and never applied here, which is the real defect: one fact about
 * shell syntax, two readers, only one of them using it. It now lives in
 * shellCommand.ts so there is one place to find it.
 *
 * Note for anyone re-testing this: a shortened version of this command does
 * NOT reproduce. The first attempt at this test invented a tidy two-line
 * heredoc, passed against the broken code, and proved nothing.
 */
const COMMAND = "cd /Users/shilpa/Desktop/Shilpa/rulereceipt\npython3 - <<'PY'\np=\"landing/index.html\"; s=open(p).read()\n\n# a monospace block style, reusing the existing panel tokens\ncss_anchor = \"  .install .cmd { color: var(--paper); }\"\nassert css_anchor in s\ns = s.replace(css_anchor, css_anchor + \"\"\"\n  .conf {\n    font-family: var(--font-mono);\n    font-size: 0.82rem;\n    line-height: 1.65;\n    background: var(--panel);\n    border: 1px solid var(--panel-line-strong);\n    border-radius: 14px;\n    padding: 16px 20px;\n    margin: 18px 0 0;\n    overflow-x: auto;\n    color: var(--paper-dim);\n    white-space: pre;\n  }\n  .conf .k { color: var(--amber); }\"\"\", 1)\n\nanchor = '''<p style=\"color:var(--paper-dim); font-size:0.92rem; margin:18px 0 0;\">Point Claude Code&rsquo;s <code>Stop</code> hook at that command.'''\nassert anchor in s\nconf = '''<p style=\"color:var(--paper-dim); font-size:0.92rem; margin:18px 0 6px;\">Add this to <code>.claude/settings.json</code> &mdash; you add it, not us:</p>\n      <div class=\"conf\">{\n  <span class=\"k\">\"hooks\"</span>: {\n    <span class=\"k\">\"Stop\"</span>: [\n      { <span class=\"k\">\"hooks\"</span>: [ { <span class=\"k\">\"type\"</span>: \"command\", <span class=\"k\">\"command\"</span>: \"npx rulereceipt hook\" } ] }\n    ]\n  }\n}</div>\n\n      ''' + anchor\ns = s.replace(anchor, conf, 1)\nopen(p,\"w\").write(s); print(\"config block added\")\nPY\nnode -e 'const h=require(\"fs\").readFileSync(\"landing/index.html\",\"utf8\");\nconsole.log(\"div\",(h.match(/<div/g)||[]).length,(h.match(/<\\/div>/g)||[]).length,\n\"| span\",(h.match(/<span/g)||[]).length,(h.match(/<\\/span>/g)||[]).length,\n\"| section\",(h.match(/<section/g)||[]).length,(h.match(/<\\/section>/g)||[]).length);'\nls landing/*.test.* landing/tests 2>/dev/null | head -3";

const rule = { id: "1", title: "Protected paths", text: "Never modify `.claude/`.", source: "project" as const };
const cls = [{ kind: "fileLifecycle", rule, filePath: ".claude/", polarity: "forbid" }] as unknown as FileLifecycleClassification[];
const bash = (command: string): TranscriptEvent[] => [
  { role: "assistant", kind: "tool_use", toolName: "Bash", input: { command }, timestamp: "t" },
];

describe("a path mentioned only inside a heredoc is not a mutation", () => {
  it("does not report .claude/ modified by a command that writes landing/index.html", () => {
    expect(runFileLifecycleChecks(cls, bash(COMMAND))[0].status).not.toBe("FAIL");
  });

  it("still reports a real mutation of the protected path", () => {
    expect(runFileLifecycleChecks(cls, bash("rm -rf .claude/"))[0].status).toBe("FAIL");
  });

  it("still reports a real mutation that follows a closed heredoc", () => {
    const after = ["cat > OTHER.md <<'EOF'", "text", "EOF", "rm -rf .claude/"].join("\n");
    expect(runFileLifecycleChecks(cls, bash(after))[0].status).toBe("FAIL");
  });
});
