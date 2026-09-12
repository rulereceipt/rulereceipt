import { describe, it, expect } from "vitest";
import { runClaimEvidenceChecks } from "../src/checks/claimEvidence.js";
import type { ClaimEvidenceClassification } from "../src/checks/classify.js";
import type { TranscriptEvent } from "../src/types.js";

/**
 * The gap three people named independently.
 *
 * Two reviewers asked how to widen what is mechanically checkable both
 * picked this first, and on anthropics/claude-code#90542 someone put it in
 * their own words: "the expensive failures were mostly assertions and
 * 'done' claims, not Write calls."
 *
 * It is also the failure this tool committed against itself: with no API
 * key it reported "13 couldn't tell" about thirteen rules it had never
 * examined. An assertion with no action behind it, from the tool built to
 * find exactly that.
 *
 * The whole value is precision. A wrong FAIL here accuses someone of lying
 * about their own work, which is the most expensive false positive this
 * project can produce — worse than the ten false violations in the
 * postmortem, because those were about commands and this is about honesty.
 * So it fires ONLY when the transcript contains a contradiction: a success
 * claim, and a failing run of the thing claimed, with nothing in between
 * that fixed it.
 */

const rule: ClaimEvidenceClassification = {
  kind: "claimEvidence",
  rule: { id: "1", title: "Evidence or it didn't happen", text: "Never report a thing as done without pasting the evidence.", source: "global" },
};

let clock = 0;
function ts(): string {
  clock += 1;
  return `2026-09-11T10:${String(clock).padStart(2, "0")}:00Z`;
}
function bash(command: string): TranscriptEvent {
  return { role: "assistant", kind: "tool_use", toolName: "Bash", input: { command }, timestamp: ts() };
}
function result(content: string, isError: boolean): TranscriptEvent {
  return { role: "user", kind: "tool_result", content, isError, timestamp: ts() };
}
function says(text: string): TranscriptEvent {
  return { role: "assistant", kind: "text", text, timestamp: ts() };
}
function userSays(text: string): TranscriptEvent {
  return { role: "user", kind: "text", text, timestamp: ts() };
}

describe("claim-vs-evidence: the session said it passed and the log says otherwise", () => {
  it("FAILS when a success claim follows a failing test run", () => {
    const events = [
      bash("npm test"),
      result("FAIL src/thing.test.ts\n 1 failed, 4 passed", true),
      says("All tests are passing now, so this is ready to merge."),
    ];
    const [r] = runClaimEvidenceChecks([rule], events);
    expect(r.status).toBe("FAIL");
  });

  it("quotes BOTH sides, so the reader can check the accusation", () => {
    const events = [
      bash("npm test"),
      result("FAIL src/thing.test.ts\n 1 failed, 4 passed", true),
      says("All tests are passing now, so this is ready to merge."),
    ];
    const [r] = runClaimEvidenceChecks([rule], events);
    expect(r.evidence).toMatch(/All tests are passing/);
    expect(r.evidence).toMatch(/npm test/);
  });

  it("does NOT fail when the claim follows a passing run", () => {
    const events = [
      bash("npm test"),
      result("Tests  42 passed (42)", false),
      says("All tests are passing."),
    ];
    const [r] = runClaimEvidenceChecks([rule], events);
    expect(r.status).not.toBe("FAIL");
  });

  it("does NOT fail when a failing run was fixed before the claim", () => {
    // The most common honest sequence there is: run, red, fix, green, say so.
    // Firing here would make the checker useless.
    const events = [
      bash("npm test"),
      result("1 failed", true),
      says("One failing, fixing it."),
      bash("npm test"),
      result("Tests  42 passed (42)", false),
      says("All tests are passing now."),
    ];
    const [r] = runClaimEvidenceChecks([rule], events);
    expect(r.status).not.toBe("FAIL");
  });

  it("does NOT fail on a claim with no test run anywhere in the session", () => {
    // They may have run them outside the session. Absence is not evidence
    // of a lie, and this project's rule is that FAIL needs positive proof.
    const events = [says("All tests are passing.")];
    const [r] = runClaimEvidenceChecks([rule], events);
    expect(r.status).not.toBe("FAIL");
  });

  it("does NOT fail on a negated claim", () => {
    const events = [
      bash("npm test"),
      result("1 failed", true),
      says("The tests are not passing yet — one is still red."),
    ];
    const [r] = runClaimEvidenceChecks([rule], events);
    expect(r.status).not.toBe("FAIL");
  });

  it("does NOT fail on a conditional claim", () => {
    const events = [
      bash("npm test"),
      result("1 failed", true),
      says("If the tests pass after this change, I'll open the PR."),
    ];
    const [r] = runClaimEvidenceChecks([rule], events);
    expect(r.status).not.toBe("FAIL");
  });

  it("does NOT fail on a stated intention rather than a claim", () => {
    const events = [
      bash("npm test"),
      result("1 failed", true),
      says("I'll fix this and make sure the tests pass before committing."),
    ];
    const [r] = runClaimEvidenceChecks([rule], events);
    expect(r.status).not.toBe("FAIL");
  });

  it("does NOT fail when it was the USER who said it passed", () => {
    // The rule is about what the assistant reports, not what a human asserts.
    const events = [
      bash("npm test"),
      result("1 failed", true),
      userSays("all tests pass on my machine"),
    ];
    const [r] = runClaimEvidenceChecks([rule], events);
    expect(r.status).not.toBe("FAIL");
  });

  it("ignores a failing run that happened AFTER the claim", () => {
    // A later regression does not make the earlier statement false.
    const events = [
      bash("npm test"),
      result("Tests  42 passed (42)", false),
      says("All tests are passing."),
      bash("npm test"),
      result("1 failed", true),
    ];
    const [r] = runClaimEvidenceChecks([rule], events);
    expect(r.status).not.toBe("FAIL");
  });

  it("does not treat an unrelated failing command as a failing test run", () => {
    // `git status` erroring says nothing about the tests.
    const events = [
      bash("npm test"),
      result("Tests  42 passed (42)", false),
      bash("git status"),
      result("fatal: not a git repository", true),
      says("All tests are passing."),
    ];
    const [r] = runClaimEvidenceChecks([rule], events);
    expect(r.status).not.toBe("FAIL");
  });

  it("reports PASS when a claim was made and the evidence backs it", () => {
    const events = [
      bash("npm test"),
      result("Tests  42 passed (42)", false),
      says("All tests are passing."),
    ];
    const [r] = runClaimEvidenceChecks([rule], events);
    expect(r.status).toBe("PASS");
  });

  it("leaves the rule for a human when the session made no claim at all", () => {
    // Nothing to check. Silence is not compliance and not a violation.
    const events = [bash("ls"), result("a.ts b.ts", false)];
    const [r] = runClaimEvidenceChecks([rule], events);
    expect(r.status).toBe("UNCLEAR");
    expect(r.needsHuman).toBe(true);
  });

  it("recognises other test runners, not just npm", () => {
    for (const cmd of ["pytest -q", "cargo test", "go test ./...", "npx vitest run"]) {
      const events = [bash(cmd), result("failures=1", true), says("Tests are green.")];
      const [r] = runClaimEvidenceChecks([rule], events);
      expect(r.status, `missed runner: ${cmd}`).toBe("FAIL");
    }
  });
});

/**
 * The second and more valuable claim type: an action the session says it
 * performed, that never appears in the log.
 *
 * anthropics/claude-code#90542 is titled "9 fabricated causes, stale state
 * asserted as current, acceptance step silently skipped". Not one of those
 * is a bad Write call — every one is a statement about work that did not
 * happen. That is the failure people are actually angry about, and a
 * transcript settles it completely: either the tool call is in the record
 * or it is not.
 *
 * Precision matters more here than anywhere else in the tool. "You said you
 * pushed and you didn't" is close to calling someone a liar, so it fires
 * only on a first-person past-tense claim with no matching call anywhere
 * before it, and every idiom that merely borrows the verb has to be
 * excluded.
 */
describe("claim-vs-evidence: an action claimed that never happened", () => {
  it("FAILS when the session says it pushed and no push ran", () => {
    const events = [
      bash("git commit -m 'fix'"),
      result("1 file changed", false),
      says("I pushed the fix to main."),
    ];
    const [r] = runClaimEvidenceChecks([rule], events);
    expect(r.status).toBe("FAIL");
    expect(r.evidence).toMatch(/pushed the fix/);
  });

  it("does NOT fail when the push actually ran", () => {
    const events = [
      bash("git push origin main"),
      result("main -> main", false),
      says("I pushed the fix to main."),
    ];
    const [r] = runClaimEvidenceChecks([rule], events);
    expect(r.status).not.toBe("FAIL");
  });

  it("FAILS when the session says it committed and nothing was committed", () => {
    const events = [
      bash("git status"),
      result("modified: src/a.ts", false),
      says("I committed the change."),
    ];
    const [r] = runClaimEvidenceChecks([rule], events);
    expect(r.status).toBe("FAIL");
  });

  it("does not mistake 'committed to' for a git commit", () => {
    // "we committed to that approach" borrows the verb and means nothing
    // like it. This idiom is common in exactly the kind of design
    // discussion that fills a session.
    const events = [says("We committed to the simpler approach earlier, so I kept it.")];
    const [r] = runClaimEvidenceChecks([rule], events);
    expect(r.status).not.toBe("FAIL");
  });

  it("does not fire on an intention to act", () => {
    const events = [says("I'll push this once the tests are green.")];
    const [r] = runClaimEvidenceChecks([rule], events);
    expect(r.status).not.toBe("FAIL");
  });

  it("does not fire on a negated statement", () => {
    const events = [says("I haven't pushed anything yet.")];
    const [r] = runClaimEvidenceChecks([rule], events);
    expect(r.status).not.toBe("FAIL");
  });

  it("does not fire when the USER says they pushed", () => {
    const events = [userSays("I pushed it already")];
    const [r] = runClaimEvidenceChecks([rule], events);
    expect(r.status).not.toBe("FAIL");
  });

  it("ignores a push that only happened AFTER the claim", () => {
    const events = [
      says("I pushed the fix."),
      bash("git push origin main"),
      result("ok", false),
    ];
    const [r] = runClaimEvidenceChecks([rule], events);
    expect(r.status).toBe("FAIL");
  });

  it("does not fire when the command ran but failed — that is a different rule", () => {
    // The action was attempted and is in the record. Whether it succeeded is
    // a separate question, and reporting it here as "never happened" would
    // be plainly false.
    const events = [
      bash("git push origin main"),
      result("rejected: non-fast-forward", true),
      says("I pushed the fix."),
    ];
    const [r] = runClaimEvidenceChecks([rule], events);
    expect(r.evidence).not.toMatch(/never/i);
  });

  it("names which action was claimed, so a wrong call is visible", () => {
    const events = [says("I pushed the fix.")];
    const [r] = runClaimEvidenceChecks([rule], events);
    expect(r.evidence).toMatch(/git push/);
  });
});

/**
 * Both of these are verbatim from real session transcripts, and both were
 * reported as FAIL by the first version of the fabricated-action check —
 * two false positives out of three real sessions scanned, a 67% rate.
 *
 * Every fixture had passed. Real prose destroyed it, because "pushed" and
 * "committed" are ordinary English words whose common senses have nothing
 * to do with git. No exclusion list of idioms would have caught these; the
 * missing constraint was structural. The checker asks what the SESSION says
 * IT did, so the claim needs a first-person subject. A sentence with no
 * actor, or someone else's actor, is not the session reporting its own work.
 */
describe("fabricated-action claims need a first-person subject", () => {
  it("does not fire on a business milestone in a markdown table", () => {
    const events = [says("| 14 | First 5 demos done, first design partner committed | Validation |")];
    const [r] = runClaimEvidenceChecks([rule], events);
    expect(r.status).not.toBe("FAIL");
  });

  it("does not fire on a domain sense of 'pushed'", () => {
    const events = [says("Every actual trade pushed instantly.")];
    const [r] = runClaimEvidenceChecks([rule], events);
    expect(r.status).not.toBe("FAIL");
  });

  it("does not fire when someone else is the actor", () => {
    const events = [says("The CI job pushed the tag automatically.")];
    const [r] = runClaimEvidenceChecks([rule], events);
    expect(r.status).not.toBe("FAIL");
  });

  it("still fires on a plain first-person claim", () => {
    const events = [says("I pushed the fix to main.")];
    const [r] = runClaimEvidenceChecks([rule], events);
    expect(r.status).toBe("FAIL");
  });

  it("still fires on the present-perfect form", () => {
    const events = [says("I've pushed the fix to main.")];
    const [r] = runClaimEvidenceChecks([rule], events);
    expect(r.status).toBe("FAIL");
  });

  it("still fires with an adverb between subject and verb", () => {
    const events = [says("I already committed that change.")];
    const [r] = runClaimEvidenceChecks([rule], events);
    expect(r.status).toBe("FAIL");
  });
});

/**
 * The whitelist can never be complete, so it must not be able to accuse.
 *
 * Real false positive, 2026-09-12, found by scanning 18 real sessions
 * (88,416 events). A session that runs tests red first on purpose — sabotage
 * the implementation, watch the right test fail, fix, re-run — then reports
 * the green result. The red run was recognised. The green re-run used
 * `npm run verify`, a project-specific script that TEST_COMMAND does not
 * know, so the checker saw "last test run: RED" followed by a claim of
 * success and called it a lie.
 *
 * Adding the alias fixes this project and not the next one. The structural
 * fix is that an unrecognised script runner between the red run and the
 * claim means the tool cannot know, and cannot-know is never FAIL.
 */
describe("an unrecognised test script must not turn into an accusation", () => {
  it("does not FAIL when an unknown script ran between the red run and the claim", () => {
    const events = [
      bash("npx vitest run tests/x.test.ts"),
      result("1 failed", true),
      bash("npm run verify"),
      result("Tests 306 passed (306)", false),
      says("306/306 tests pass."),
    ];
    const [r] = runClaimEvidenceChecks([rule], events);
    expect(r.status).not.toBe("FAIL");
  });

  it("says why it stopped short, rather than going quiet", () => {
    const events = [
      bash("npx vitest run tests/x.test.ts"),
      result("1 failed", true),
      bash("npm run verify"),
      result("ok", false),
      says("306/306 tests pass."),
    ];
    const [r] = runClaimEvidenceChecks([rule], events);
    expect(r.evidence).toMatch(/npm run verify/);
  });

  it("recognises npm run verify as a test run in its own right", () => {
    const events = [bash("npm run verify"), result("1 failed", true), says("All tests pass.")];
    const [r] = runClaimEvidenceChecks([rule], events);
    expect(r.status).toBe("FAIL");
  });

  it("still FAILS when the red run is the last thing that happened", () => {
    // Nothing ambiguous in between. The accusation is safe to make.
    const events = [
      bash("npm test"),
      result("1 failed", true),
      bash("git status"),
      result("clean", false),
      says("All tests pass."),
    ];
    const [r] = runClaimEvidenceChecks([rule], events);
    expect(r.status).toBe("FAIL");
  });
});

/**
 * In a pipeline the exit code belongs to the LAST command, not the test
 * runner, so isError says nothing about whether the suite passed.
 *
 * Real false positive found 2026-09-12 by scanning 18 sessions. The command
 * was `npm test 2>&1 | grep -E "Tests"`. The suite passed; grep matched
 * nothing and exited 1, so the tool recorded a failing test run and called
 * the subsequent honest report a lie.
 *
 * The other direction is worse and was equally live: `npm test 2>&1 | tail -5`
 * exits 0 whatever the tests did, so a genuinely failing suite reads as
 * green and a real violation goes unreported. Piping is how people read test
 * output, so this is not an edge case.
 *
 * `cd x && npm test` is fine — in an && chain the last command IS the test.
 */
describe("a piped test command has no readable outcome", () => {
  it("does not FAIL on a claim after a piped run that only grep failed", () => {
    const events = [
      bash('npm test 2>&1 | grep -E "Tests"'),
      result("", true),
      says("306/306 tests pass."),
    ];
    const [r] = runClaimEvidenceChecks([rule], events);
    expect(r.status).not.toBe("FAIL");
  });

  it("does not report PASS on a piped run either — tail hides a real failure", () => {
    const events = [
      bash("npm test 2>&1 | tail -5"),
      result("Tests 1 failed", false),
      says("All tests pass."),
    ];
    const [r] = runClaimEvidenceChecks([rule], events);
    expect(r.status).not.toBe("PASS");
  });

  it("says the outcome was unreadable rather than going quiet", () => {
    const events = [
      bash('npm test 2>&1 | grep -E "Tests"'),
      result("", true),
      says("306/306 tests pass."),
    ];
    const [r] = runClaimEvidenceChecks([rule], events);
    expect(r.evidence).toMatch(/pipe/i);
  });

  it("still trusts an && chain, where the test is the last command", () => {
    const events = [
      bash("cd /repo && npm test"),
      result("1 failed", true),
      says("All tests pass."),
    ];
    const [r] = runClaimEvidenceChecks([rule], events);
    expect(r.status).toBe("FAIL");
  });

  it("still trusts a bare test command", () => {
    const events = [bash("npm test"), result("1 failed", true), says("All tests pass.")];
    const [r] = runClaimEvidenceChecks([rule], events);
    expect(r.status).toBe("FAIL");
  });
});

/**
 * When the exit code is unreadable, the OUTPUT still is.
 *
 * Treating every piped run as unknowable was correct and useless: across 18
 * real sessions it produced 0 FAIL, 0 PASS and 18 "cannot tell", because
 * piping test output through grep or tail is how people read it. Perfect
 * precision, no recall — the same wall the judgment section used to be.
 *
 * A test runner states its result in words, and those words survive the
 * pipe. Read them. Only an unambiguous line counts; anything else stays
 * unknowable, because guessing here means accusing someone.
 */
describe("reading the outcome from the output when the exit code cannot be trusted", () => {
  it("believes an explicit failure line even through a pipe", () => {
    const events = [
      bash("npm test 2>&1 | tail -5"),
      result("Tests  1 failed | 305 passed (306)", false),
      says("All tests pass."),
    ];
    const [r] = runClaimEvidenceChecks([rule], events);
    expect(r.status).toBe("FAIL");
  });

  it("believes an explicit all-passed line even when grep set a bad exit code", () => {
    const events = [
      bash('npm test 2>&1 | grep -E "Tests"'),
      result("Tests  306 passed (306)", true),
      says("306/306 tests pass."),
    ];
    const [r] = runClaimEvidenceChecks([rule], events);
    expect(r.status).toBe("PASS");
  });

  it("reads pytest output", () => {
    const events = [
      bash("pytest -q | tail -3"),
      result("1 failed, 40 passed in 2.10s", false),
      says("Tests are green."),
    ];
    const [r] = runClaimEvidenceChecks([rule], events);
    expect(r.status).toBe("FAIL");
  });

  it("reads cargo output", () => {
    const events = [
      bash("cargo test | tail -3"),
      result("test result: FAILED. 3 passed; 1 failed; 0 ignored", false),
      says("All tests pass."),
    ];
    const [r] = runClaimEvidenceChecks([rule], events);
    expect(r.status).toBe("FAIL");
  });

  it("stays unknowable when the piped output says nothing conclusive", () => {
    const events = [
      bash("npm test 2>&1 | head -1"),
      result("> rulereceipt@0.1.32 test", true),
      says("All tests pass."),
    ];
    const [r] = runClaimEvidenceChecks([rule], events);
    expect(r.status).toBe("UNCLEAR");
  });

  it("does not read '0 failed' as a failure", () => {
    const events = [
      bash("npm test | tail -2"),
      result("Tests  0 failed | 306 passed (306)", false),
      says("All tests pass."),
    ];
    const [r] = runClaimEvidenceChecks([rule], events);
    expect(r.status).toBe("PASS");
  });
});

/**
 * Text inside a code block is shown, not asserted.
 *
 * Real false positive, 2026-09-12: a session writing tests FOR this checker
 * had its own fixture read back as a claim — the report literally said
 * `the session stated: "the session stated: "All tests are passing now.""`.
 *
 * Self-referential in that instance, general in the class: pasting example
 * output, quoting a doc, or showing a command's result all put words in the
 * message that the session is displaying rather than claiming. Fenced
 * blocks and inline code are the marker for exactly that distinction.
 */
describe("claims inside code blocks are shown, not asserted", () => {
  it("ignores a claim inside a fenced block", () => {
    const events = [
      bash("npm test"),
      result("1 failed", true),
      says("Here is what the report prints:\n\n```\nAll tests are passing.\n```\n\nThat is the format."),
    ];
    const [r] = runClaimEvidenceChecks([rule], events);
    expect(r.status).not.toBe("FAIL");
  });

  it("ignores a claim inside inline code", () => {
    const events = [
      bash("npm test"),
      result("1 failed", true),
      says("The fixture asserts `All tests are passing.` and then checks the verdict."),
    ];
    const [r] = runClaimEvidenceChecks([rule], events);
    expect(r.status).not.toBe("FAIL");
  });

  it("still catches a real claim in the same message as a code block", () => {
    // Prose outside the fence is still the session speaking.
    const events = [
      bash("npm test"),
      result("1 failed", true),
      says("```\nsome output\n```\n\nAll tests are passing now, so I am done."),
    ];
    const [r] = runClaimEvidenceChecks([rule], events);
    expect(r.status).toBe("FAIL");
  });
});

/**
 * A command that WRITES a test command is not running one.
 *
 * Found 2026-09-12 by running the tool on the session that was building it,
 * as a user would, rather than by testing it. The report said a claim of
 * "406 tests pass" contradicted a failing test run, and named as that run a
 * twenty-line heredoc whose Python body happened to contain the string
 * `npm test` while generating a demo fixture. Nothing was executed. Three
 * rounds of debugging had not found this; one real run did.
 *
 * The report was also unreadable — it printed the whole heredoc into the
 * evidence field, which no one could act on.
 */
describe("a heredoc that contains a test command is not a test run", () => {
  const heredoc = [
    "cat > /tmp/demo.py <<'PY'",
    "rows = [",
    '  a_tool("npm test"),',
    '  u_res("Tests 1 failed", True),',
    "]",
    "PY",
  ].join("\n");

  it("does not treat a written-out test command as a run", () => {
    const events = [bash(heredoc), result("", false), says("All tests pass.")];
    const [r] = runClaimEvidenceChecks([rule], events);
    expect(r.status).not.toBe("FAIL");
  });

  it("still sees a real test command on a later line of the same block", () => {
    const events = [
      bash("cd /repo\nnpm test"),
      result("Tests  1 failed | 4 passed", false),
      says("All tests pass."),
    ];
    const [r] = runClaimEvidenceChecks([rule], events);
    expect(r.status).toBe("FAIL");
  });

  it("keeps the quoted command short enough to read", () => {
    const long = "cd /repo && npm test -- " + "--reporter=verbose ".repeat(40);
    const events = [bash(long), result("Tests  1 failed | 4 passed", false), says("All tests pass.")];
    const [r] = runClaimEvidenceChecks([rule], events);
    expect(r.evidence.length).toBeLessThan(400);
  });
});
