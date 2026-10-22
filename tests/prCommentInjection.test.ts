import { describe, it, expect } from "vitest";
import { renderPrComment } from "../src/prComment.js";
import type { Receipt } from "../src/receipt.js";

/**
 * Pen-test (2026-10-22): PR-comment injection.
 *
 * A PR comment is PUBLIC and posted by the Action with the repo's token. In an
 * open-source repo a fork PR controls both the committed receipt and the
 * CLAUDE.md it was checked against, so every receipt-derived string that reaches
 * the markdown — rule titles, the tool version — is UNTRUSTED. The Action's shell
 * path is already safe (inputs via env, quoted, --body-file); this guards the
 * markdown CONTENT so it cannot:
 *   - notify third parties with an @mention,
 *   - break out of the <details> fold or inject raw HTML (</details>, <img>),
 *   - forge an issue/PR cross-reference (#123),
 *   - disguise a phishing link as safe text ([click me](https://evil)).
 *
 * Evidence is already neutralised (wrapped in a code span with backticks
 * stripped); these cases pin the title + version, which were raw.
 */

function receipt(results: Receipt["results"], over: Partial<Receipt> = {}): Receipt {
  const r = results as { status?: string }[];
  return {
    tool: "rulereceipt",
    schema: 1,
    version: "0.1.118",
    generatedAt: "2026-10-22T09:00:00.000Z",
    session: { path: null, sha256: "abc" },
    summary: { total: r.length, pass: 0, fail: r.filter((x) => x.status === "FAIL").length, unclear: 0 },
    results,
    ...over,
  };
}

describe("PR-comment injection — untrusted title/version cannot inject markdown", () => {
  it("an @mention in a rule title does not render as a live mention", () => {
    const md = renderPrComment(receipt([
      { ruleTitle: "ping @ravikiran now", status: "FAIL", evidence: "x" },
    ]));
    // No bare "@ravikiran" that GitHub would autolink into a notification.
    expect(md).not.toMatch(/(^|[^0-9A-Za-z`&;])@ravikiran\b/);
    // It is still readable — the entity renders as a literal '@' glyph.
    expect(md).toContain("&#64;ravikiran");
  });

  it("a </details> in a rule title cannot break out of the fold", () => {
    const md = renderPrComment(receipt([
      { ruleTitle: "x</details><img src=y onerror=alert(1)>", status: "FAIL", evidence: "e" },
    ]));
    expect(md).not.toContain("</details><img");
    expect(md).not.toMatch(/<img\b/);
    expect(md).toContain("&lt;/details&gt;");
  });

  it("a markdown link in a rule title cannot become a live link", () => {
    const md = renderPrComment(receipt([
      { ruleTitle: "[click me](https://evil.example)", status: "FAIL", evidence: "e" },
    ]));
    // The "](" link syntax must not survive intact.
    expect(md).not.toContain("](https://evil.example)");
    expect(md).not.toContain("[click me]");
  });

  it("a #123 reference in a rule title does not forge a cross-reference", () => {
    const md = renderPrComment(receipt([
      { ruleTitle: "fixes #1337", status: "FAIL", evidence: "e" },
    ]));
    expect(md).not.toMatch(/(^|[^0-9A-Za-z`&;])#1337\b/);
    expect(md).toContain("&#35;1337");
  });

  it("an injected version string cannot carry markup or a mention", () => {
    const md = renderPrComment(receipt([{ ruleTitle: "ok", status: "FAIL", evidence: "e" }], {
      version: "</sub> @everyone <img src=x>",
    }));
    expect(md).not.toMatch(/<img\b/);
    expect(md).not.toContain("</sub> @everyone");
  });

  it("evidence stays inert inside its code span (regression guard)", () => {
    const md = renderPrComment(receipt([
      { ruleTitle: "ok", status: "FAIL", evidence: "@everyone <script>alert(1)</script>" },
    ]));
    // Evidence is wrapped in a code span, so the mention/script are literal text
    // on GitHub — the raw characters appearing BETWEEN backticks is correct and
    // inert. What matters is that it is inside a code span, not bare markdown.
    expect(md).toContain("`@everyone <script>alert(1)</script>`");
  });
});
