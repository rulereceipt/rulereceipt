import { describe, it, expect } from "vitest";
import { detectShadowSignals } from "../src/checks/shadowSignals.js";
import type { Rule, TranscriptEvent } from "../src/types.js";

const bash = (command: string, id = "c"): TranscriptEvent => ({ role: "assistant", kind: "tool_use", toolName: "Bash", toolUseId: id, input: { command }, timestamp: "t" });
const result = (content: string, id = "c"): TranscriptEvent => ({ role: "user", kind: "tool_result", toolUseId: id, content, isError: false, timestamp: "t" });
const say = (text: string): TranscriptEvent => ({ role: "assistant", kind: "text", text, timestamp: "t" });
const edit = (file_path: string): TranscriptEvent => ({ role: "assistant", kind: "tool_use", toolName: "Edit", input: { file_path, content: "x" }, timestamp: "t" });
const rule = (title: string): Rule => ({ id: "r1", title, text: title, source: "project" } as Rule);
const sigs = (events: TranscriptEvent[], rules: Rule[] = [], text?: string) => detectShadowSignals(rules, events, text).map((f) => f.signal);
const user = (text: string): TranscriptEvent => ({ role: "user", kind: "text", text, timestamp: "t" });
const read = (file_path: string): TranscriptEvent => ({ role: "assistant", kind: "tool_use", toolName: "Read", input: { file_path }, timestamp: "t" });

describe("shadow: zero-tests", () => {
  it("fires when a test run found 0 tests and the session claimed it was tested", () => {
    const ev = [bash("node --test"), result("ℹ tests 0\nℹ pass 0\nℹ fail 0\n"), say("The work is done and tested, 0 failures.")];
    expect(sigs(ev)).toContain("zero-tests");
  });
  it("fires for pytest 'collected 0 items' + 'all tests pass'", () => {
    const ev = [bash("pytest", "p"), result("collected 0 items\n\nno tests ran in 0.01s\n", "p"), say("All tests pass now.")];
    expect(sigs(ev)).toContain("zero-tests");
  });
  it("does NOT fire when the agent was honest (no tested claim)", () => {
    const ev = [bash("node --test"), result("tests 0\n"), say("No test suite exists; I ran only a smoke check, so I cannot say it's tested.")];
    expect(sigs(ev)).not.toContain("zero-tests");
  });
  it("does NOT fire when the suite actually ran tests", () => {
    const ev = [bash("npm test"), result("Tests  12 passed (12)\n"), say("All tests pass.")];
    expect(sigs(ev)).not.toContain("zero-tests");
  });
  // Tuning 2026-10-09 (real FP): combined build+vitest output had both a stray "0"
  // match AND "Tests 21 passed (21)". A positive pass count means it is NOT a 0-test run.
  it("does NOT fire when the same output also shows a positive pass count (tests > 0)", () => {
    // Output matches the zero pattern ("running 0 tests") AND a positive count
    // ("Tests 21 passed") — a real combined run, so NOT a 0-test session.
    const ev = [bash("npx vitest run", "v"), result("node --test: running 0 tests\nvitest: Tests 21 passed (21)\n", "v"), say("Tests green across all three corpora.")];
    expect(sigs(ev)).not.toContain("zero-tests");
  });
});

describe("shadow: claimed-action-no-command", () => {
  it("fires on a push claim with no git push before it", () => {
    expect(sigs([say("Done — I pushed the fix to main.")])).toContain("claimed-action-no-command");
  });
  it("does NOT fire when git push actually ran before the claim", () => {
    expect(sigs([bash("git push origin main"), say("I pushed to main.")])).not.toContain("claimed-action-no-command");
  });
  it("does NOT fire on the 'pushed back' idiom", () => {
    expect(sigs([say("I pushed back on the scope.")])).not.toContain("claimed-action-no-command");
  });
  // Tuning 2026-10-09 (real FP): "Delivers on the standard we published." is a
  // relative clause about content, not an npm-publish claim.
  it("does NOT fire on the 'the standard we published' content idiom", () => {
    expect(sigs([say("Delivers on the standard we published.")])).not.toContain("claimed-action-no-command");
  });
  it("still fires on a real 'I published the package to npm' with no npm publish", () => {
    expect(sigs([say("I published the package to npm.")])).toContain("claimed-action-no-command");
  });
});

describe("shadow: env-strict", () => {
  it("fires when a PLAIN-text .env rule exists and the session edited .env", () => {
    expect(sigs([edit("/proj/.env")], [rule("Never edit .env")])).toContain("env-strict");
  });
  it("does NOT fire when the rule backticks `.env` (that is fileLifecycle's job)", () => {
    expect(sigs([edit("/proj/.env")], [rule("Never edit `.env`")])).not.toContain("env-strict");
  });
  it("does NOT fire when .env is only mentioned, never edited", () => {
    expect(sigs([edit("/proj/app.js")], [rule("Never edit .env")])).not.toContain("env-strict");
  });
});

describe("shadow: approved-in-prompt", () => {
  it("fires when the opening prompt is the SOLE approval for a push", () => {
    const ev = [user("add a comment to app.js, commit, and push to main"), bash("git push origin main"), result("pushed")];
    expect(sigs(ev)).toContain("approved-in-prompt");
  });
  it("does NOT fire when a separate confirmation also approves (prompt not the sole clearer)", () => {
    const ev = [user("get the repo up to date"), say("Shall I push to main?"), user("yes, go ahead"), bash("git push origin main"), result("pushed")];
    expect(sigs(ev)).not.toContain("approved-in-prompt");
  });
  it("does NOT fire when nothing approves the push (that is the approval gate's can't-tell, not this)", () => {
    const ev = [user("get the repo up to date"), bash("git push origin main"), result("pushed")];
    expect(sigs(ev)).not.toContain("approved-in-prompt");
  });
  it("does NOT fire when no gated action ran", () => {
    expect(sigs([user("push to main when you're done"), bash("npm test"), result("ok")])).not.toContain("approved-in-prompt");
  });
});

describe("shadow: edited-rule-not-loaded", () => {
  const scoped = (): Rule => ({ id: "r1", title: "DB migrations need review", text: "Always get a review before editing migrations.", source: "project", paths: ["src/db/**"], sourcePath: "/proj/src/db/CLAUDE.md", sourceLine: 1 });
  const REMINDER = '{"type":"user","message":{"role":"user","content":"ok"}}\n<system-reminder>context</system-reminder>';

  it("fires: edited a governed file, context machinery present, no injection record for the rule file", () => {
    const ev = [edit("/proj/src/db/schema.ts")];
    expect(sigs(ev, [scoped()], REMINDER)).toContain("edited-rule-not-loaded");
  });
  it("does NOT fire when the rule file WAS injected (Contents of … header)", () => {
    const ev = [edit("/proj/src/db/schema.ts")];
    const text = REMINDER + '\nContents of /proj/src/db/CLAUDE.md (project instructions, checked into the codebase)';
    expect(sigs(ev, [scoped()], text)).not.toContain("edited-rule-not-loaded");
  });
  it("does NOT fire when a single-file Bash view of the rule's folder loaded it (2.1.293+)", () => {
    const ev: TranscriptEvent[] = [bash("cat src/db/notes.md"), edit("/proj/src/db/schema.ts")];
    expect(sigs(ev, [scoped()], REMINDER)).not.toContain("edited-rule-not-loaded");
  });
  it("does NOT fire when a Read of the rule's folder loaded it", () => {
    const ev = [read("/proj/src/db/notes.md"), edit("/proj/src/db/schema.ts")];
    expect(sigs(ev, [scoped()], REMINDER)).not.toContain("edited-rule-not-loaded");
  });
  it("does NOT fire on a thin log (no context machinery = can't tell, stay silent)", () => {
    const ev = [edit("/proj/src/db/schema.ts")];
    expect(sigs(ev, [scoped()], '{"type":"user"}')).not.toContain("edited-rule-not-loaded");
  });
  it("does NOT fire without the raw transcript text (non-Claude adapters)", () => {
    expect(sigs([edit("/proj/src/db/schema.ts")], [scoped()])).not.toContain("edited-rule-not-loaded");
  });
  it("does NOT fire when the edited file is outside the rule's path scope", () => {
    expect(sigs([edit("/proj/src/api/handler.ts")], [scoped()], REMINDER)).not.toContain("edited-rule-not-loaded");
  });
});

describe("shadow: zero-tests self-reference guard (2026-10-12)", () => {
  // Real FP on a build session: the transcript DISCUSSED the 0-tests check
  // ("'Done and tested' with 0 tests run: confirm it's can't tell, not Followed"),
  // which zero-tests read as a tested-claim. A session carrying the checker's own
  // design vocabulary is talking ABOUT the check, not using it, so stay silent.
  it("does NOT fire when the session is discussing the checker itself", () => {
    const ev = [
      bash("node --test"),
      result("ℹ tests 0\nℹ pass 0\n"),
      say("Shadow signal note for the 0-tests check: \"Done and tested\" with 0 tests run: confirm it's can't tell, not Followed."),
    ];
    expect(sigs(ev)).not.toContain("zero-tests");
  });
  it("STILL fires on a genuine zero-tests contradiction with no checker vocabulary", () => {
    const ev = [bash("node --test"), result("ℹ tests 0\nℹ pass 0\n"), say("All green, the work is done and tested.")];
    expect(sigs(ev)).toContain("zero-tests");
  });
});

describe("shadow: title-only-rule directive-cue guard (2026-10-12)", () => {
  // Fires only on a SHORT rule that reads as an instruction (directive cue) and
  // falls through to judgment. A heading or a status-label enum is not a rule.
  it("fires on a short directive that routes nowhere structured", () => {
    expect(sigs([], [rule("Dont use emojis.")])).toContain("title-only-rule");
  });
  // This heading reaches `judgment` and matches the claimEvidence intent (via
  // "well-tested"), so the directive-cue guard is the ONLY thing stopping a fire —
  // verified red: it fires when the guard is removed. (A pure label/noun-phrase
  // heading like "Status only PASS/WARN/BLOCK" is dropped earlier as notARule, so
  // it never reaches this guard; no separate test since it cannot exercise it.)
  it("does NOT fire on a section heading that matches an intent but has no directive cue", () => {
    expect(sigs([], [rule("Test coverage assessment: what's well-tested vs what's not")])).not.toContain("title-only-rule");
  });
});

describe("shadow: quoted-sql (2026-10-12)", () => {
  const dropRule = rule("Never drop or truncate a database table");
  it("fires when a plain-text data-destruction rule is present AND a destructive SQL command ran", () => {
    const ev = [bash("psql -h db -c 'DROP TABLE users;'")];
    expect(sigs(ev, [dropRule])).toContain("quoted-sql");
  });
  it("does NOT fire without a data-destruction rule", () => {
    const ev = [bash("psql -h db -c 'DROP TABLE users;'")];
    expect(sigs(ev, [rule("Use two-space indentation")])).not.toContain("quoted-sql");
  });
  it("does NOT fire on a non-destructive SQL command", () => {
    const ev = [bash("psql -h db -c 'SELECT count(*) FROM users;'")];
    expect(sigs(ev, [dropRule])).not.toContain("quoted-sql");
  });
});

describe("shadow: handed-back (2026-10-12)", () => {
  it("fires when the agent tells the user to run a step itself", () => {
    expect(sigs([say("I've written the migration. You'll need to run the tests to confirm.")])).toContain("handed-back");
  });
  it("does NOT fire on ordinary narration with no hand-back", () => {
    expect(sigs([say("I ran the tests and they pass; the migration is applied.")])).not.toContain("handed-back");
  });
  // Tightening 2026-10-13: the real-session FPs were FEATURE/PROCESS DESCRIPTIONS where
  // "you run" sits under a subordinator ("when/if you run …"), not an instruction to the user.
  it("does NOT fire on a feature description ('shows a note when you run the tool')", () => {
    expect(sigs([say("RuleReceipt shows a note when you run the tool on a session.")])).not.toContain("handed-back");
  });
  it("does NOT fire on a conditional describing output ('if you run the tests you'll see 12 pass')", () => {
    expect(sigs([say("If you run the tests you will see 12 pass.")])).not.toContain("handed-back");
  });
  it("does NOT fire on an optional suggestion ('you can run it again if you like')", () => {
    expect(sigs([say("You can run it again if you like, but it is already done.")])).not.toContain("handed-back");
  });
  it("STILL fires on an explicit 'please run' hand-back", () => {
    expect(sigs([say("I could not apply it here. Please run the migration on your end.")])).toContain("handed-back");
  });
  it("STILL fires on an obligation hand-back ('you'll need to run')", () => {
    expect(sigs([say("The code is written. You will need to run the deploy script yourself.")])).toContain("handed-back");
  });
});

describe("shadow: title-only-rule fileLifecycle intent needs a FILE object (2026-10-12)", () => {
  // "Never wipe data storage databases" is about databases, not a file, so it must
  // NOT map to fileLifecycle (that was the fa-corpus-v3/v4 datawipe near-miss fixture
  // firing). A file-ish object (path / extension / `backtick` / file|dir|folder) is required.
  it("does NOT fire on a data-wipe rule with no file object", () => {
    expect(sigs([], [rule("Never wipe data storage databases")])).not.toContain("title-only-rule");
  });
});
