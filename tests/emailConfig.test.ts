import { describe, it, expect } from "vitest";
import { isValidEmail, detectSmtpHost } from "../src/emailConfig.js";

describe("isValidEmail", () => {
  it("accepts a normal address", () => {
    expect(isValidEmail("dev@company.com")).toBe(true);
  });

  it("accepts a subdomain address", () => {
    expect(isValidEmail("manager@team.company.co.uk")).toBe(true);
  });

  // proves the check can actually fail, not just pass by construction
  it("rejects a missing @", () => {
    expect(isValidEmail("bobgmail.com")).toBe(false);
  });

  it("rejects a missing domain", () => {
    expect(isValidEmail("bob@")).toBe(false);
  });

  it("rejects a missing TLD", () => {
    expect(isValidEmail("bob@gmail")).toBe(false);
  });

  it("rejects an embedded space", () => {
    expect(isValidEmail("bob gmail.com")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isValidEmail("")).toBe(false);
  });

  it("tolerates surrounding whitespace from copy-paste", () => {
    expect(isValidEmail("  dev@company.com  ")).toBe(true);
  });
});

describe("detectSmtpHost", () => {
  it("recognizes gmail.com", () => {
    expect(detectSmtpHost("dev@gmail.com")).toEqual({ host: "smtp.gmail.com", port: 465 });
  });

  it("returns null for an unrecognized provider", () => {
    expect(detectSmtpHost("dev@some-random-company.io")).toBeNull();
  });
});
