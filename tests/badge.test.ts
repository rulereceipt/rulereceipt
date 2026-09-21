import { describe, it, expect } from "vitest";
import { buildBadge } from "../src/badge.js";

describe("buildBadge", () => {
  it("red 'N failing' when a rule failed", () => {
    const b = buildBadge({ pass: 2, fail: 3, unclear: 1 });
    expect(b).toMatchObject({ schemaVersion: 1, label: "rules", message: "3 failing", color: "red" });
  });

  it("green 'passing' when nothing failed and something passed", () => {
    const b = buildBadge({ pass: 5, fail: 0, unclear: 2 });
    expect(b).toMatchObject({ message: "passing", color: "brightgreen" });
  });

  it("grey 'unclear' when only judgment rules with nothing to grade", () => {
    const b = buildBadge({ pass: 0, fail: 0, unclear: 4 });
    expect(b).toMatchObject({ message: "unclear", color: "lightgrey" });
  });

  it("a single failure still reads red, not green (does not overstate)", () => {
    expect(buildBadge({ pass: 10, fail: 1, unclear: 0 }).color).toBe("red");
  });
});
