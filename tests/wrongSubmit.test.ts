import { describe, it, expect } from "vitest";
import type { SpawnSyncReturns } from "node:child_process";
import { redact, buildWrongReport } from "../src/wrong.js";
import { ghReady, issueTitle, issueCreateArgs, buildMailto, mailtoSubject, SUPPORT_EMAIL, MAILTO_MAX } from "../src/wrongSubmit.js";
import type { CheckResult, Rule } from "../src/types.js";

/**
 * `wrong --submit`/`--email`: the pure pieces. Sending happens in cli.ts only
 * after an explicit yes; these lock the masking, the exact gh argv, and the
 * mailto. Rule of the feature: nothing leaves the machine without a "y".
 */

describe("redact — the added secret formats", () => {
  const cases: Array<[string, string, RegExp]> = [
    ["Stripe secret key", "key sk_live_ABCDEFGHIJ0123456789xyz", /redacted-stripe-key/],
    ["Stripe webhook secret", "whsec_ABCDEFGHIJ0123456789abcd", /redacted-stripe-secret/],
    ["JWT", "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk", /redacted-jwt/],
    ["password in URL", "clone https://" + "alice:s3cr3tpass" + "@github.com/x/y.git", /alice:<redacted>@github\.com/],
    ["private key block", "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----", /redacted-private-key/],
    [".env KEY=value", "API_SECRET=supersecretvalue123", /API_SECRET=<redacted>/],
  ];
  for (const [name, input, expected] of cases) {
    it(`masks a ${name}`, () => {
      expect(redact(input, "/no/home")).toMatch(expected);
    });
  }
  it("leaves a short flag value alone (DISABLE_LOCKS=1)", () => {
    expect(redact("run DISABLE_LOCKS=1 npm test", "/no/home")).toContain("DISABLE_LOCKS=1");
  });
  it("does not leak the raw secret after masking", () => {
    expect(redact("sk_live_ABCDEFGHIJ0123456789xyz", "/no/home")).not.toContain("sk_live_ABCDEFGHIJ0123456789xyz");
  });
});

describe("issue argv + title", () => {
  it("titles as 'Wrong verdict: <verdict> on <rule, <=60 chars>'", () => {
    const long = "x".repeat(200);
    const t = issueTitle("Not followed", long);
    expect(t.startsWith("Wrong verdict: Not followed on ")).toBe(true);
    expect(t.length).toBeLessThanOrEqual("Wrong verdict: Not followed on ".length + 60);
  });
  it("includes --label wrong-verdict only when asked", () => {
    expect(issueCreateArgs("t", "b", true)).toContain("wrong-verdict");
    expect(issueCreateArgs("t", "b", false)).not.toContain("wrong-verdict");
  });
  it("passes the body through verbatim (so a masked report stays masked)", () => {
    const args = issueCreateArgs("t", "MASKED BODY <redacted>", true);
    expect(args[args.indexOf("--body") + 1]).toBe("MASKED BODY <redacted>");
  });
});

describe("mailto", () => {
  it("targets the maintainer address with the right subject", () => {
    const { url } = buildMailto(mailtoSubject("Never push to main"), "body");
    expect(url.startsWith(`mailto:${SUPPORT_EMAIL}?`)).toBe(true);
    expect(decodeURIComponent(url)).toContain("RuleReceipt wrong verdict: Never push to main");
  });
  it("trims a long body and flags it", () => {
    const big = "y".repeat(MAILTO_MAX + 500);
    const { url, trimmed } = buildMailto("s", big);
    expect(trimmed).toBe(true);
    expect(decodeURIComponent(url)).toContain("attach the saved .md file");
  });
});

describe("ghReady (mocked runner)", () => {
  const ret = (status: number): SpawnSyncReturns<Buffer> =>
    ({ status, stdout: Buffer.from(""), stderr: Buffer.from(""), pid: 1, output: [], signal: null } as SpawnSyncReturns<Buffer>);
  it("false when gh is absent", () => {
    expect(ghReady(() => ret(127))).toBe(false);
  });
  it("false when gh is present but not logged in", () => {
    expect(ghReady((_c, a) => ret(a[0] === "--version" ? 0 : 1))).toBe(false);
  });
  it("true only when installed AND logged in", () => {
    expect(ghReady(() => ret(0))).toBe(true);
  });
});

describe("buildWrongReport — masking reaches the shared surfaces", () => {
  const rule: Rule = { id: "S1.1", title: "Never leak keys", text: "Never leak keys", source: "project" };
  const result: CheckResult = { ruleId: "S1.1", ruleTitle: "Never leak keys", ruleSource: "project", status: "FAIL", evidence: 'wrote sk_live_ABCDEFGHIJ0123456789xyz to a file' };
  const report = buildWrongReport({ version: "9.9.9", rule, result, events: [], home: "/no/home" });
  it("carries the 'read before sending' masking disclaimer", () => {
    expect(report.markdown).toContain("Masking catches common formats only. Read before sending.");
  });
  it("masks the secret in BOTH the markdown and the pre-filled link", () => {
    expect(report.markdown).not.toContain("sk_live_ABCDEFGHIJ0123456789xyz");
    expect(report.issueUrl).not.toContain("sk_live_ABCDEFGHIJ0123456789xyz");
  });
});
