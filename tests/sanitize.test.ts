import { describe, it, expect } from "vitest";
import { stripTerminalEscapes } from "../src/sanitize.js";
import { redact } from "../src/wrong.js";

describe("stripTerminalEscapes", () => {
  it("removes an OSC-8 hyperlink, CSI colours and cursor moves, keeps the text", () => {
    const evil = "git \u001b]8;;https://evil.com\u0007click\u001b]8;;\u0007 \u001b[31mFAKE\u001b[0m \u001b[2Kmain";
    const out = stripTerminalEscapes(evil);
    expect(out).toBe("git click FAKE main");
    expect(out).not.toContain("\u001b");
    expect(out).not.toContain("8;;");
  });
  it("removes other C0/C1 controls (BEL, backspace) but keeps \\n and \\t", () => {
    expect(stripTerminalEscapes("a\u0007b\u0008c\u0000d")).toBe("abcd");
    expect(stripTerminalEscapes("line1\nline2\tcol")).toBe("line1\nline2\tcol");
  });
  it("leaves ordinary text untouched (fast path)", () => {
    expect(stripTerminalEscapes("git push origin main")).toBe("git push origin main");
  });
  it("redact() output never contains an ESC byte", () => {
    const out = redact("x \u001b[31m \u001b]8;;http://a\u0007b\u0007 y");
    expect(out).not.toContain("\u001b");
  });
});
