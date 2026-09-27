import { describe, it, expect } from "vitest";
import { withoutHeredocs, segments, leadingCommand } from "../src/checks/shellCommand.js";

/**
 * Two heredoc-parsing gaps found 2026-09-26 (both proved red against the old
 * regex before this):
 *  (a) `<<\EOF` (backslash-escaped delimiter, valid POSIX) was not recognised,
 *      so the body was never stripped — a command that WRITES a test command
 *      read as one that RUNS it, the exact bug withoutHeredocs exists to stop.
 *  (b) a line that merely MENTIONS `<<WORD` inside a string
 *      (`echo "usage: cat <<EOF"`) put the parser into body mode with no real
 *      closer, silently deleting every following line — hiding a real later
 *      command from every caller.
 */
describe("withoutHeredocs recognises real openers and only real ones", () => {
  it("(a) strips a backslash-escaped delimiter body", () => {
    const out = withoutHeredocs("cat <<\\EOF > /tmp/f\nRun this: npm test\nEOF");
    expect(out).not.toContain("npm test");
  });

  it("still strips quoted and bare delimiter bodies", () => {
    expect(withoutHeredocs("cat <<'EOF'\nnpm test\nEOF")).not.toContain("npm test");
    expect(withoutHeredocs("cat <<EOF\nnpm test\nEOF")).not.toContain("npm test");
    expect(withoutHeredocs('cat <<"EOF"\nnpm test\nEOF')).not.toContain("npm test");
  });

  it("(b) does NOT treat a quoted mention of <<WORD as an opener", () => {
    const out = withoutHeredocs('echo "example usage: cat <<EOF"\nnpm test');
    expect(out).toContain("npm test");
  });

  it("keeps a real command that FOLLOWS a genuine heredoc", () => {
    const out = withoutHeredocs("cat > f.txt <<EOF\nexample body\nEOF\nnpm test");
    expect(out).not.toContain("example body");
    expect(out).toContain("npm test");
  });

  it("recognises an opener with a redirect after the delimiter", () => {
    expect(withoutHeredocs("cat <<EOF > out.txt\nnpm test\nEOF")).not.toContain("npm test");
  });
});

describe("segments and leadingCommand", () => {
  it("splits a compound command and reads the leading executable", () => {
    const segs = segments('grep "rm -rf" notes.txt && npm run build');
    expect(segs.length).toBe(2);
    expect(leadingCommand(segs[0])).toBe("grep");
    expect(leadingCommand(segs[1])).toBe("npm");
  });

  it("skips env assignments and sudo when reading the leading command", () => {
    expect(leadingCommand("FOO=bar sudo git commit -m x")).toBe("git");
  });

  it("does not split on operators inside a heredoc body", () => {
    const segs = segments("cat <<EOF\na && b ; c\nEOF\ngit commit -m x");
    expect(segs.some((s) => leadingCommand(s) === "git")).toBe(true);
    expect(segs.some((s) => /a && b/.test(s))).toBe(false);
  });
});
