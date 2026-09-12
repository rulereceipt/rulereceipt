import { describe, it, expect } from "vitest";
import { classifyRule } from "../src/checks/classify.js";
import type { Rule } from "../src/types.js";

function makeRule(text: string, title = "Some rule"): Rule {
  return { id: "1", title, text, source: "project" };
}

describe("classifyRule", () => {
  it("classifies a rule with a backtick-quoted literal as deterministic", () => {
    const rule = makeRule("Never run `git push --force` under any circumstances.");
    const result = classifyRule(rule);
    expect(result.kind).toBe("deterministic");
  });

  it("extracts the exact literal pattern, not a paraphrase", () => {
    const rule = makeRule("Never run `git push --force`.");
    const result = classifyRule(rule);
    if (result.kind === "deterministic") {
      expect(result.patterns).toContain("git push --force");
    } else {
      throw new Error("expected deterministic classification");
    }
  });

  it("classifies a purely judgment-based rule (their real Rule 4) as judgment, not deterministic", () => {
    const rule = makeRule(
      "Lead every status report with what is broken, failing, unverified, or worse than expected.",
      "Surface bad news first"
    );
    expect(classifyRule(rule).kind).toBe("judgment");
  });

  // assertion updated 2026-08-30 when notARule was introduced: an empty
  // rule has no instruction in it, so there is nothing to check compliance
  // against. Reporting N/A is more honest than spending an LLM call to
  // grade an empty string, which is what "judgment" used to mean here.
  it("classifies an empty rule as notARule — nothing to check, rather than an LLM call", () => {
    const rule = makeRule("");
    expect(classifyRule(rule).kind).toBe("notARule");
  });

  // proves this test can fail: a rule with no backticks must NOT be
  // misclassified as deterministic
  it("FAILS the deterministic check for a rule with quotes but no backticks (sanity check)", () => {
    const rule = makeRule('Never say "done" without evidence.');
    expect(classifyRule(rule).kind).not.toBe("deterministic");
  });

  describe("polarity detection (forbid vs require)", () => {
    it("classifies a 'never' rule as forbid", () => {
      const rule = makeRule("Never run `git push --force`.");
      const result = classifyRule(rule);
      if (result.kind !== "deterministic") throw new Error("expected deterministic");
      expect(result.polarity).toBe("forbid");
    });

    it("classifies an 'always' rule as require", () => {
      const rule = makeRule("Always run `npm test` before committing.");
      const result = classifyRule(rule);
      if (result.kind !== "deterministic") throw new Error("expected deterministic");
      expect(result.polarity).toBe("require");
    });

    it("classifies a 'must' rule as require", () => {
      const rule = makeRule("You must run `npm run typecheck` before every commit.");
      const result = classifyRule(rule);
      if (result.kind !== "deterministic") throw new Error("expected deterministic");
      expect(result.polarity).toBe("require");
    });

    it("defaults to forbid when both a forbid and a require word appear (a ban stated as 'must never')", () => {
      const rule = makeRule("You must never run `rm -rf /`.");
      const result = classifyRule(rule);
      if (result.kind !== "deterministic") throw new Error("expected deterministic");
      expect(result.polarity).toBe("forbid");
    });

    it("defaults to forbid when neither signal word is present (preserves old behavior, no regression)", () => {
      const rule = makeRule("Use `npm` for this project.");
      const result = classifyRule(rule);
      if (result.kind !== "deterministic") throw new Error("expected deterministic");
      expect(result.polarity).toBe("forbid");
    });
  });

  describe("ifEditThenTest classification (new: previously fell through to judgment)", () => {
    it("classifies 'every change needs a test' as ifEditThenTest, not judgment", () => {
      const rule = makeRule("Every new function needs a corresponding test.");
      expect(classifyRule(rule).kind).toBe("ifEditThenTest");
    });

    it("classifies 'always add tests' as ifEditThenTest", () => {
      const rule = makeRule("Always add tests for every production code change.");
      expect(classifyRule(rule).kind).toBe("ifEditThenTest");
    });

    it("does NOT classify a purely descriptive test-quality rule as ifEditThenTest (needs both signals)", () => {
      const rule = makeRule("Write good, readable tests.");
      expect(classifyRule(rule).kind).not.toBe("ifEditThenTest");
    });

    it("does NOT override an existing backtick-based deterministic rule, even if it mentions tests", () => {
      const rule = makeRule("Always run `npm test` before committing.");
      expect(classifyRule(rule).kind).toBe("deterministic");
    });

    // real false-positive found 2026-08-30 on an actual session: this
    // exact real global rule ("test" + "must" both present) was
    // misclassified as ifEditThenTest, producing nonsense like "you
    // edited .env but no test file was touched" for a rule that is
    // actually about test QUALITY, not "every edit needs a test file"
    it("does NOT classify 'Tests must be able to fail' (a test-quality rule) as ifEditThenTest", () => {
      const rule = makeRule(
        "Any test you write must be demonstrated to fail on bad input at least once (show the red run) before its green run counts. A test that cannot fail is decoration.",
        "Tests must be able to fail"
      );
      expect(classifyRule(rule).kind).not.toBe("ifEditThenTest");
    });
  });

  describe("gitBranchPolicy classification (new structured primitive, 2026-08-30)", () => {
    it("routes a rule naming a branch in backticks, that also says 'branch', to gitBranchPolicy", () => {
      const rule = makeRule("Never touch the `demo` branch.", "No demo branch");
      const result = classifyRule(rule);
      expect(result.kind).toBe("gitBranchPolicy");
      if (result.kind === "gitBranchPolicy") {
        expect(result.branchName).toBe("demo");
      }
    });

    it("does NOT route a backtick rule to gitBranchPolicy when it doesn't mention 'branch' at all", () => {
      const rule = makeRule("Never run `git push --force`.");
      expect(classifyRule(rule).kind).toBe("deterministic");
    });
  });

  // Measured against 40 real public rule files (1,441 parsed items,
  // 2026-08-30): only ~20% contained any directive language. The rest is
  // documentation, and 521 of those were getting keyword checks run
  // against them — the single largest false-positive source found.
  describe("notARule classification — documentation is not checked (2026-08-30)", () => {
    it("classifies a directory-listing glossary entry as notARule", () => {
      const rule = makeRule("`forge/llm/` - Multi-provider LLM integrations (OpenAI, Anthropic)");
      expect(classifyRule(rule).kind).toBe("notARule");
    });

    it("classifies a model-reference table entry as notARule", () => {
      const rule = makeRule("`claude-opus` - opus smart, sonnet fast");
      expect(classifyRule(rule).kind).toBe("notARule");
    });

    it("classifies a glob-syntax documentation entry as notARule", () => {
      const rule = makeRule("`**` - Matches any path including `/`");
      expect(classifyRule(rule).kind).toBe("notARule");
    });

    // the guard that keeps this from silently swallowing real rules:
    // directive language anywhere means it IS a rule, whatever its shape
    it("does NOT classify as notARule when directive language is present, even in glossary shape", () => {
      const rule = makeRule("`.env` - never commit this file");
      expect(classifyRule(rule).kind).not.toBe("notARule");
    });

    it("does NOT classify a normal prose rule as notARule", () => {
      const rule = makeRule("Never run `git push --force`.");
      expect(classifyRule(rule).kind).toBe("deterministic");
    });

    it("does NOT classify a judgment rule as notARule", () => {
      const rule = makeRule("Lead every status report with what is broken.", "Surface bad news first");
      expect(classifyRule(rule).kind).toBe("judgment");
    });

    // assertion updated 2026-08-30 when detection was inverted from
    // "looks like documentation" to "contains a directive". A purely
    // descriptive sentence instructs the agent to do nothing, so there is
    // no compliance question to answer — N/A is the correct answer, and
    // the earlier "send it to judgment" behavior was spending an LLM call
    // to grade a statement of fact.
    it("classifies a purely descriptive statement as notARule — it instructs nothing", () => {
      const rule = makeRule("The build system uses Bazel for the core packages.");
      expect(classifyRule(rule).kind).toBe("notARule");
    });
  });

  // Real misclassifications reported from an independent run against a
  // real, large rules file (2026-08-30). Each one is a permanent
  // regression test now, not a one-off fix.
  describe("real-world misclassifications reported from a live run", () => {
    it("a section header is not a rule", () => {
      expect(classifyRule(makeRule("Quick Reference - All Repositories")).kind).toBe("notARule");
    });

    it("a folder listing row is not a rule", () => {
      expect(classifyRule(makeRule("nogit/ - Contains archived non-git folders")).kind).toBe("notARule");
    });

    it("a git-remote reference row is not a rule", () => {
      expect(classifyRule(makeRule("Git: git@github.com:acme-core/acme-core-app.git")).kind).toBe("notARule");
    });

    it("a pointer to where information lives is not a rule", () => {
      expect(
        classifyRule(makeRule("Reference: `analytics.ts` in each frontend project for the available API")).kind
      ).toBe("notARule");
    });

    // the worst of the reported cases: literals from the PRESCRIBED half
    // were checked against the rule's forbid polarity, so running exactly
    // the command the rule demands got reported as violating it
    it("a rule that forbids one thing and prescribes another goes to judgment, not a literal guess", () => {
      const rule = makeRule("NEVER squash when merging PRs. Use `gh pr merge {number} --merge --admin`");
      expect(classifyRule(rule).kind).toBe("judgment");
    });

    // the guard on that: a single-clause prohibition whose own verb is a
    // command word is NOT mixed polarity, and must stay a literal check
    it("a single-clause prohibition stays deterministic even though its verb is a command word", () => {
      const rule = makeRule("Never run `git push --force`.");
      expect(classifyRule(rule).kind).toBe("deterministic");
    });
  });

  describe("codeContent classification (structured primitive, 2026-08-30)", () => {
    it("routes a rule naming a function/method call to codeContent", () => {
      const rule = makeRule("Never leave a `print(` statement in committed code.");
      expect(classifyRule(rule).kind).toBe("codeContent");
    });

    it("does NOT route a plain CLI command rule to codeContent", () => {
      const rule = makeRule("Never run `git push --force`.");
      expect(classifyRule(rule).kind).toBe("deterministic");
    });
  });

  describe("fileLifecycle classification (structured primitive, 2026-08-30)", () => {
    it("routes a file-protection rule to fileLifecycle", () => {
      const rule = makeRule("Never modify `.claude/settings.json`.");
      const result = classifyRule(rule);
      expect(result.kind).toBe("fileLifecycle");
      if (result.kind === "fileLifecycle") {
        expect(result.filePath).toBe(".claude/settings.json");
      }
    });

    it("routes a bare-filename protection rule to fileLifecycle", () => {
      const rule = makeRule("Never delete `config.yaml`.");
      expect(classifyRule(rule).kind).toBe("fileLifecycle");
    });

    // needs BOTH a path shape and mutation intent — a rule that merely
    // mentions a file isn't a protection rule
    it("does NOT route to fileLifecycle when the rule names a file but has no mutation intent", () => {
      const rule = makeRule("Read `config.yaml` before starting work.");
      expect(classifyRule(rule).kind).not.toBe("fileLifecycle");
    });

    it("does NOT route a CLI command containing a slash to fileLifecycle", () => {
      const rule = makeRule("Never change the remote with `git remote set-url origin`.");
      expect(classifyRule(rule).kind).not.toBe("fileLifecycle");
    });
  });
});

/**
 * An incident write-up is a record of something that happened. It is not
 * a directive addressed to the agent, and enforcing it produces results
 * that are worse than useless.
 *
 * Found by running the tool on a real session (2026-08-31). A section
 * titled "Real incident (2026-08-28): Vercel had the same office/personal
 * mixup" was classified as a REQUIRE rule whose pattern was an employer
 * name lifted out of the narrative — so the report announced FOLLOWED
 * because that name appeared somewhere in the session. The rule being
 * "satisfied" was a sentence describing a past mistake.
 *
 * These sections do contain directives further down ("Verify with
 * `vercel whoami` before every deploy"), which is why the existing
 * directive test passes on them and why this needs its own signal: what
 * the section IS, is announced by its title.
 */
describe("incident write-ups are records, not rules", () => {
  it("does not enforce a dated incident report", () => {
    const rule = makeRule(
      "`vercel whoami` returned `tools-9274` under team `acme-ai` (office) — a completely separate login. Fix required a full re-auth. Verify with `vercel whoami` before every `vercel --prod` deploy.",
      "Real incident (2026-08-28): Vercel had the same office/personal mixup"
    );
    expect(classifyRule(rule).kind).toBe("notARule");
  });

  it("does not enforce an incident report whose title states an outcome", () => {
    const rule = makeRule(
      "Every deployment from 2026-08-26 through 2026-08-29 was stuck Blocked. The real cause: the Git repository was never connected.",
      "Real incident (2026-08-29): the actual deploy-blocker was never the email"
    );
    expect(classifyRule(rule).kind).toBe("notARule");
  });

  it("does not enforce a postmortem section", () => {
    const rule = makeRule(
      "The migration ran twice because the lock was released early. Always take the lock before starting.",
      "Postmortem: what went wrong with the March rollout"
    );
    expect(classifyRule(rule).kind).toBe("notARule");
  });

  // The guard. A real directive must keep working even when it mentions
  // an incident as its justification — that is how good rules are written.
  it("STILL enforces a real rule that cites an incident as its reason", () => {
    const rule = makeRule(
      "After the incident on 2026-08-28, all work happens on a branch. Never commit directly to `main`.",
      "Never commit directly to `main`"
    );
    expect(classifyRule(rule).kind).not.toBe("notARule");
  });

  it("STILL enforces a rule whose title is an ordinary directive", () => {
    expect(classifyRule(makeRule("Always run `npm test` before pushing.", "Always run `npm test` before pushing")).kind).not.toBe("notARule");
  });

  // ---- documentation of a command, not an instruction to follow ----
  // Real corpus cases. These slip past the directive test because command
  // documentation uses the same imperative verbs as an instruction: the
  // line describes what the flag DOES ("Use alternative tasks.json file")
  // rather than telling the agent to do anything.

  it("treats a CLI flag's own documentation as not a rule", () => {
    expect(classifyRule(makeRule("`--file=<path>, -f`: Use alternative tasks.json file")).kind).toBe("notARule");
    expect(classifyRule(makeRule("`--with-subtasks`: Show subtasks for each task")).kind).toBe("notARule");
    expect(classifyRule(makeRule("`--status=<status>`: New status value (required)")).kind).toBe("notARule");
  });

  it("treats a section whose entire body is a command as not a rule", () => {
    expect(classifyRule(makeRule(".\\gradlew assembleRelease", "Build release APK")).kind).toBe("notARule");
    expect(classifyRule(makeRule("cp .env.copy .env", "Copy environment template")).kind).toBe("notARule");
    expect(classifyRule(makeRule("cargo test -p deno_core", "Run tests in a specific package")).kind).toBe("notARule");
  });

  // ---- guards: these must NOT be swept up by the above ----

  it("still treats a rule that names a command as a rule", () => {
    expect(classifyRule(makeRule("Never run `git push --force` under any circumstances.")).kind).not.toBe("notARule");
    expect(classifyRule(makeRule("Always pass `--frozen-lockfile` when installing dependencies.")).kind).not.toBe("notARule");
  });

  it("still treats prose that mentions a command as a rule", () => {
    expect(classifyRule(makeRule("Run `npm test` before every push.", "Testing")).kind).not.toBe("notARule");
    expect(classifyRule(makeRule("Use `--dry-run` first when the change is destructive.")).kind).not.toBe("notARule");
  });
});

describe("classifyRule routes claim-vs-evidence rules away from judgment", () => {
  const mk = (title: string, text: string) => ({ id: "1", title, text, source: "project" as const });

  it("routes a rule that demands evidence for a done claim", () => {
    const r = mk(
      "Evidence or it didn't happen",
      "Never report an item done, confirmed or working without pasting the specific evidence in the same message."
    );
    expect(classifyRule(r).kind).toBe("claimEvidence");
  });

  it("needs BOTH halves — a reporting verb alone is not enough", () => {
    // "tell me what changed" is about reporting and nothing else.
    const r = mk("Summarise changes", "Tell me what changed in each file at the end of the session.");
    expect(classifyRule(r).kind).not.toBe("claimEvidence");
  });

  it("needs BOTH halves — an evidence noun alone is not enough", () => {
    // This is a test-running rule, not a claim rule.
    const r = mk("Run the tests", "Always run the test suite and check the output before pushing.");
    expect(classifyRule(r).kind).not.toBe("claimEvidence");
  });

  it("does not swallow a plain literal prohibition", () => {
    const r = mk("No force pushing", "Never run `git push --force`.");
    expect(classifyRule(r).kind).not.toBe("claimEvidence");
  });
});

describe("claim-vs-evidence routing does not swallow pre-action gate rules", () => {
  const mk = (title: string, text: string) => ({ id: "1", title, text, source: "project" as const });

  it("does NOT route a confirm-before-acting rule", () => {
    // Real misroute, 2026-09-11, verbatim text from a live CLAUDE.md. It
    // carries a reporting verb ("say"), an evidence noun ("paste evidence")
    // and a done-word ("are done"), so it routed to claimEvidence and was
    // then answered with "you claimed a passing test suite 10 times" — a
    // non-sequitur. Its subject is a gate before an action, not a report of
    // a result. Written verbatim because an earlier paraphrase of this rule
    // dropped the exact word that caused the misroute and the test passed
    // against unfixed code.
    const r = mk(
      "Repeat-back before destructive or expensive actions",
      `Before: deleting data, overwriting profiles/ledgers, re-running long backfills, changing
DRY_RUN, placing live orders, or modifying anything tagged with a version — restate what
will be changed, what will be lost, and wait for confirmation.

DRY_RUN flip rule: Before flipping DRY_RUN=False, you MUST:
1. Run the Rule 6 pre-flight (restate what changes, what's at risk, what other services
   are affected).
2. Verify all other services remain DRY_RUN=True (paste evidence).
3. Wait for Shilpa to say explicit go-ahead — phrases like "verified, go live",
   "confirmed, flip it", "make dry run false", or "go live" after a pre-flight count.
Once all three steps are done, you MAY flip DRY_RUN=False and restart the daemon yourself.`
    );
    expect(classifyRule(r).kind).not.toBe("claimEvidence");
  });

  it("still routes a plain report-with-evidence rule", () => {
    const r = mk(
      "Evidence or it didn't happen",
      "Never report an item done, confirmed or working without pasting the specific evidence in the same message."
    );
    expect(classifyRule(r).kind).toBe("claimEvidence");
  });

  it("still routes a rule about not upgrading assumed to done", () => {
    const r = mk(
      "Distinguish the three states honestly",
      "Every reported item must be labeled DONE (evidence pasted), OPEN, or ASSUMED. Never upgrade ASSUMED to DONE without running the verification."
    );
    expect(classifyRule(r).kind).toBe("claimEvidence");
  });
});


/**
 * A rule whose only backtick literal is punctuation or a stopword is not a
 * deterministic rule — the classifier was wrong to call it one.
 *
 * Found 2026-09-12 by running 559 real rules files against 5 real sessions:
 * 2,795 reports, 18,025 verdicts, 967 FAIL. The corpus yields 267 patterns
 * that cannot identify anything. `,` appears 22 times and matches every file
 * containing a comma; `/`, `:`, `!` match everything; `or`, `in`, `is` match
 * ordinary prose. Each is a machine for confident accusations about nothing.
 *
 * Dropping the pattern is not enough. If nothing checkable is left, the
 * premise for calling the rule mechanical has gone, and it belongs in
 * judgment where a person decides.
 */
describe("a rule whose literals cannot identify anything is not deterministic", () => {
  const mk = (title: string, text: string) => ({ id: "1", title, text, source: "project" as const });

  it("does not treat a comma as a checkable literal", () => {
    // Needs a directive word, or it is notARule for an unrelated reason and
    // the test proves nothing about the comma.
    expect(classifyRule(mk("Reading results", "Always separate the fields with `,` when exporting.")).kind).toBe("judgment");
  });

  it("does not treat punctuation as a checkable literal", () => {
    for (const p of ["/", ":", "!", "\\"]) {
      expect(classifyRule(mk("Style", `Always use \`${p}\` in the header.`)).kind, `punctuation ${p}`).toBe("judgment");
    }
  });

  it("does not treat a common English word as a checkable literal", () => {
    for (const w of ["or", "in", "is", "the", "to"]) {
      expect(classifyRule(mk("Convention", `Use \`${w}\` in the message.`)).kind, `stopword ${w}`).toBe("judgment");
    }
  });

  it("keeps a short but real command name", () => {
    const k = classifyRule(mk("Dangerous commands", "Never run `rm -rf` on the repo.")).kind;
    expect(k).not.toBe("judgment");
  });

  it("keeps a rule that has one junk literal and one real one", () => {
    const k = classifyRule(mk("Force push", "Never use `,` or `git push --force` here.")).kind;
    expect(k).not.toBe("judgment");
  });
});
