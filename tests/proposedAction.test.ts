import { describe, it, expect } from "vitest";
import { commandRunsLiteral } from "../src/checks/proposedAction.js";

/**
 * Before a command runs, a banned literal in it usually IS the act. Usually.
 *
 * This is the question the post-hoc checker refuses to answer, and the
 * reason is written into deterministicChecks.ts: a text match cannot tell an
 * action from a mention, so it reports UNCLEAR and never accuses. At
 * PreToolUse most of that ambiguity is gone, because the command in the
 * payload is the thing about to happen.
 *
 * What is left is a command that quotes a literal while doing something
 * harmless with it — searching for it, printing it, writing it into a file,
 * putting it in a commit message. Every "allowed" case below is one of those,
 * and each is a shell someone would otherwise have had blocked.
 *
 * The cost here is asymmetric in the other direction from the report. A
 * missed violation costs what it always cost. A false block stops someone
 * working, in their own terminal, with no obvious way to tell why.
 */
const BAN = "git push --force";

describe("a proposed command that actually does the forbidden thing", () => {
  it("blocks the bare command", () => {
    expect(commandRunsLiteral("git push --force origin main", BAN)).toBe(true);
  });
  it("blocks the short-flag spelling", () => {
    expect(commandRunsLiteral("git push -f origin main", BAN)).toBe(true);
  });
  it("blocks it in the middle of a chain", () => {
    expect(commandRunsLiteral("npm run build && git push --force && echo done", BAN)).toBe(true);
  });
});

describe("a proposed command that only mentions it", () => {
  it("allows grepping for it", () => {
    expect(commandRunsLiteral('grep -rn "git push --force" docs/', BAN)).toBe(false);
  });
  it("allows echoing it", () => {
    expect(commandRunsLiteral('echo "never run git push --force"', BAN)).toBe(false);
  });
  it("allows it inside a heredoc body", () => {
    expect(commandRunsLiteral("cat > RULES.md <<'EOF'\nNever run git push --force.\nEOF", BAN)).toBe(false);
  });
  it("allows it inside a commit message", () => {
    expect(commandRunsLiteral('git commit -m "document why git push --force is banned"', BAN)).toBe(false);
  });
  it("allows a read-only git subcommand that mentions it", () => {
    expect(commandRunsLiteral('git log --grep "git push --force"', BAN)).toBe(false);
  });
  it("allows the safer long-form flag", () => {
    expect(commandRunsLiteral("git push --force-with-lease origin main", BAN)).toBe(false);
  });
  it("allows a grep segment while still blocking a real one beside it", () => {
    expect(commandRunsLiteral('grep -q "git push --force" f && git push --force', BAN)).toBe(true);
  });
});

describe("rules that name a read-only command are still enforced", () => {
  it("blocks `git config user.email` when that is what the rule bans", () => {
    expect(commandRunsLiteral("git config user.email x@y.z", "git config user.email")).toBe(true);
  });
});
