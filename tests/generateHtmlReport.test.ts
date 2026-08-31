import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { generateHtmlReport, type HtmlReportMeta } from "../src/report/generateHtmlReport.js";
import type { CheckResult } from "../src/types.js";

function result(over: Partial<CheckResult> = {}): CheckResult {
  return {
    ruleId: "1",
    ruleTitle: "Never commit directly to main",
    ruleSource: "project",
    status: "PASS",
    evidence: "no git command targeted the main branch",
    ...over,
  };
}

function meta(over: Partial<HtmlReportMeta> = {}): HtmlReportMeta {
  return {
    sessionFilePath: null,
    ruleCount: 1,
    projectPath: "/home/dev/acme-api",
    generatedAt: new Date("2026-08-31T09:00:00.000Z"),
    toolVersion: "0.1.18",
    ...over,
  };
}

describe("generateHtmlReport", () => {
  // THE security test for this file. Rule titles come from CLAUDE.md, which
  // can arrive with a cloned repo; evidence quotes real session content.
  // Unescaped markup here is stored XSS in a document whose entire purpose
  // is to be opened and trusted by someone who did not run the check.
  describe("untrusted input can never become markup", () => {
    it("escapes a script tag in a rule title", () => {
      const html = generateHtmlReport([result({ ruleTitle: "<script>alert(1)</script>" })], meta());
      expect(html).not.toContain("<script>alert(1)</script>");
      expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    });

    it("escapes a script tag in evidence", () => {
      const html = generateHtmlReport([result({ evidence: "<script>steal()</script>" })], meta());
      expect(html).not.toContain("<script>steal()</script>");
      expect(html).toContain("&lt;script&gt;steal()&lt;/script&gt;");
    });

    it("escapes an img onerror payload", () => {
      const html = generateHtmlReport([result({ ruleTitle: `<img src=x onerror="alert(1)">` })], meta());
      expect(html).not.toContain("<img src=x");
      expect(html).not.toContain('onerror="alert(1)"');
    });

    // The project path is shown inside a <code> element; a crafted cwd is a
    // less likely but still real vector, and costs nothing to close.
    it("escapes markup in the project path", () => {
      const html = generateHtmlReport([result()], meta({ projectPath: "/tmp/<script>x</script>" }));
      expect(html).not.toContain("<script>x</script>");
    });

    it("escapes quotes so a value cannot break out of an attribute", () => {
      const html = generateHtmlReport([result({ ruleTitle: `" onmouseover="alert(1)` })], meta());
      expect(html).not.toContain(`onmouseover="alert(1)`);
      expect(html).toContain("&quot;");
    });

    // The whole document must contain no executable surface at all, so a
    // payload that slipped past escaping still has nothing to attach to.
    // Asserted against TAGS specifically: an escaped payload legitimately
    // renders the literal text `onclick="` as visible content, which is
    // inert. Only a handler inside a real tag is a vulnerability.
    it("emits a document with no script element and no inline event handler", () => {
      const html = generateHtmlReport(
        [result({ ruleTitle: "<script>a</script>", evidence: `<b onclick="b()">x</b>` })],
        meta()
      );
      expect(html).not.toMatch(/<script[\s>]/i);
      const tags = html.match(/<[^>]*>/g) ?? [];
      expect(tags.filter((t) => /\son[a-z]+\s*=/i.test(t))).toEqual([]);
    });

    it("strips control characters, matching the terminal report", () => {
      const html = generateHtmlReport([result({ ruleTitle: "clean[31mred" })], meta());
      expect(html).not.toContain("");
      expect(html).not.toContain("");
    });
  });

  describe("self-contained", () => {
    // A compliance reader may open this offline, from an attachment, years
    // later. Any external reference is a future broken document.
    it("makes no external requests — no remote src, href, or @import", () => {
      const html = generateHtmlReport([result()], meta());
      expect(html).not.toMatch(/src\s*=\s*["']https?:/i);
      expect(html).not.toMatch(/<link[^>]+href\s*=\s*["']https?:/i);
      expect(html).not.toMatch(/@import/i);
    });

    it("is a complete standalone document", () => {
      const html = generateHtmlReport([result()], meta());
      expect(html.trimStart().startsWith("<!doctype html>")).toBe(true);
      expect(html).toContain("</html>");
    });
  });

  describe("failures are surfaced first, never buried", () => {
    it("places the not-followed section before the followed section", () => {
      const html = generateHtmlReport(
        [
          result({ ruleId: "1", status: "PASS", ruleTitle: "Passing rule" }),
          result({ ruleId: "2", status: "FAIL", ruleTitle: "Failing rule" }),
        ],
        meta()
      );
      expect(html.indexOf("Failing rule")).toBeLessThan(html.indexOf("Passing rule"));
    });

    it("leads the verdict with the failure count when anything failed", () => {
      const html = generateHtmlReport([result({ status: "FAIL" })], meta());
      expect(html).toContain("1 rule not followed");
      expect(html).toContain("verdict--fail");
    });

    // Both unresolved kinds must appear in the headline. "No rule
    // violations found" alone, when half the rules were never evaluated
    // mechanically, reads as full coverage — which is the overclaim this
    // whole report is built to avoid.
    // The apostrophe arrives HTML-escaped, which is the escaping choke
    // point doing its job on our own copy as well as on untrusted input.
    it("does not claim a clean result when the evidence was ambiguous", () => {
      const html = generateHtmlReport([result({ status: "UNCLEAR" })], meta());
      expect(html).toContain("couldn&#39;t be determined");
      expect(html).toContain(`<div class="verdict verdict--unclear">`);
    });

    it("does not claim a clean result when rules still need human review", () => {
      const html = generateHtmlReport([result({ status: "UNCLEAR", needsHuman: true })], meta());
      expect(html).toContain("still need human review");
      expect(html).not.toContain(`<div class="verdict verdict--pass">`);
    });

    // ...but a judgment call is not a failure, and must not be dressed as one.
    // Scoped to the rendered element: the stylesheet always defines every
    // verdict class regardless of outcome.
    it("does not style a judgment call as a problem", () => {
      const html = generateHtmlReport([result({ status: "UNCLEAR", needsHuman: true })], meta());
      expect(html).not.toContain(`<div class="verdict verdict--fail">`);
      expect(html).toContain(`<div class="verdict verdict--judgment">`);
    });

    // Scoped to the rendered verdict element, not the whole document — the
    // stylesheet always defines every status class regardless of outcome.
    it("omits a section entirely when it has no results", () => {
      const html = generateHtmlReport([result({ status: "PASS" })], meta());
      expect(html).not.toContain(`<div class="verdict verdict--fail">`);
      expect(html).toContain(`<div class="verdict verdict--pass">`);
      expect(html).not.toContain("Not followed</h2>");
    });
  });

  // The report must never imply an authority it does not have — this is
  // the property that makes it usable as an audit document rather than a
  // liability.
  describe("honest framing", () => {
    it("never uses the word 'compliant'", () => {
      const html = generateHtmlReport([result({ status: "PASS" })], meta());
      expect(html.toLowerCase()).not.toContain("compliant");
    });

    it("states what the report does not establish", () => {
      const html = generateHtmlReport([result()], meta());
      expect(html).toContain("What this report does not establish");
      expect(html).toContain("not a compliance certification");
    });
  });

  describe("verification block", () => {
    it("prints the real session hash and a runnable verify command", () => {
      const dir = mkdtempSync(join(tmpdir(), "rr-html-"));
      const session = join(dir, "session.jsonl");
      writeFileSync(session, '{"type":"assistant"}\n');
      try {
        const html = generateHtmlReport([result()], meta({ sessionFilePath: session }));
        expect(html).toContain("sha256:");
        expect(html).toContain("rulereceipt verify");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("says plainly there is nothing to verify when run on sample data", () => {
      const html = generateHtmlReport([result()], meta({ sessionFilePath: null }));
      expect(html).toContain("nothing to verify");
      expect(html).not.toContain("rulereceipt verify &lt;session-file&gt; sha256:</code>");
    });
  });

  describe("rule labelling", () => {
    it("disambiguates the source only when two rules share an id", () => {
      const collide = generateHtmlReport(
        [
          result({ ruleId: "1", ruleSource: "global", ruleTitle: "Global one" }),
          result({ ruleId: "1", ruleSource: "project", ruleTitle: "Project one" }),
        ],
        meta()
      );
      expect(collide).toContain("Rule 1 (global)");
      expect(collide).toContain("Rule 1 (project)");

      const noCollide = generateHtmlReport([result({ ruleId: "1" })], meta());
      expect(noCollide).toContain("Rule 1<");
      expect(noCollide).not.toContain("Rule 1 (project)");
    });
  });
});

/**
 * Home-path redaction. Found by dogfooding on a real session
 * (2026-08-31): the shareable report — the one output explicitly designed
 * to leave the machine — printed absolute paths like
 * /Users/<realname>/Desktop/... in the project header AND inside quoted
 * evidence. For anyone publishing under a pseudonym that is a leak in the
 * worst possible artifact.
 *
 * Deliberately narrow: this removes the home prefix and nothing else. It
 * is not a secret scrubber, and the CLI warns separately that rule text
 * and evidence are reproduced verbatim.
 */
describe("absolute home paths never reach the shareable report", () => {
  const home = homedir();

  it("replaces the home directory in the project header", () => {
    const html = generateHtmlReport([result()], meta({ projectPath: `${home}/Desktop/work/api` }));
    expect(html).not.toContain(home);
    expect(html).toContain("~/Desktop/work/api");
  });

  it("replaces the home directory inside quoted evidence", () => {
    const html = generateHtmlReport([result({ evidence: `ran: cd ${home}/Desktop/secret-project && ls` })], meta());
    expect(html).not.toContain(home);
    expect(html).toContain("~/Desktop/secret-project");
  });

  it("replaces it in a rule title too", () => {
    const html = generateHtmlReport([result({ ruleTitle: `Never touch ${home}/private` })], meta());
    expect(html).not.toContain(home);
  });

  it("leaves unrelated absolute paths alone — this is not a path scrubber", () => {
    const html = generateHtmlReport([result({ evidence: "wrote to /etc/hosts and /var/log/app.log" })], meta());
    expect(html).toContain("/etc/hosts");
    expect(html).toContain("/var/log/app.log");
  });
});
