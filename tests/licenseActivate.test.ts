import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync, sign as edSign, type KeyObject } from "node:crypto";
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LICENSE_PREFIX,
  encodePayload,
  signingInput,
  type LicensePayload,
  type Tier,
} from "../src/license/format.js";
import { verifyLicense } from "../src/license/verify.js";
import { activateLicense } from "../src/license/activate.js";
import {
  saveEntitlement,
  loadStoredLicense,
  loadActiveEntitlement,
  clearEntitlement,
  entitlementPath,
  type StoredLicense,
} from "../src/license/entitlement.js";

/**
 * Diwali critical path (2026-10-28): `rulereceipt activate <key>` — VERIFY ONLY.
 *
 * This is the consumer side of the offline license. It holds only the PUBLIC
 * key and must:
 *   - accept a genuine, in-date key and store the entitlement,
 *   - fail CLOSED on a forged signature, a tampered payload, an expired key, a
 *     not-yet-valid key, a wrong prefix, and junk — never storing any of them,
 *   - re-verify the stored license on every read, so hand-editing the JSON
 *     (e.g. upgrading the tier) grants nothing.
 * Tests mint keys with an EPHEMERAL keypair so they never depend on the shipped
 * key and the private signer never appears in this repo.
 */

// --- ephemeral issuer (test-only; stands in for the private repo) -----------
let privateKey: KeyObject;
let publicPem: string;
let otherPublicPem: string; // a DIFFERENT trusted key — a key signed by `privateKey` must NOT verify under it

function mint(over: Partial<LicensePayload> = {}, signer: KeyObject = privateKey): string {
  const now = Date.now();
  const payload: LicensePayload = {
    v: 1,
    tier: "team-10",
    seats: 10,
    email: "buyer@example.com",
    orderId: "ord_test_1",
    issuedAt: new Date(now - 86_400_000).toISOString(),
    expiresAt: new Date(now + 30 * 86_400_000).toISOString(),
    graceDays: 5,
    ...over,
  };
  const payloadB64 = encodePayload(payload);
  const sig = edSign(null, signingInput(payloadB64), signer).toString("base64url");
  return `${LICENSE_PREFIX}.${payloadB64}.${sig}`;
}

function genPair(): { privateKey: KeyObject; publicPem: string } {
  const { privateKey: pk, publicKey } = generateKeyPairSync("ed25519");
  return { privateKey: pk, publicPem: publicKey.export({ type: "spki", format: "pem" }) as string };
}

beforeEach(() => {
  const main = genPair();
  privateKey = main.privateKey;
  publicPem = main.publicPem;
  otherPublicPem = genPair().publicPem;
});

const key = (pem: string) => [{ mode: "live" as const, pem }];

describe("activate — happy path", () => {
  it("accepts a genuine in-date key and stores the decoded entitlement", () => {
    const license = mint({ tier: "team-40", seats: 40, email: "ops@acme.com" });
    const saved: StoredLicense[] = [];
    const out = activateLicense(license, { keys: key(publicPem), save: (s) => saved.push(s) });
    expect(out.ok).toBe(true);
    expect(out.exitCode).toBe(0);
    expect(out.message).toMatch(/Team \(up to 40 devs\)/);
    expect(out.message).toContain("ops@acme.com");
    expect(saved).toHaveLength(1);
    expect(saved[0]!.license).toBe(license);
    expect(saved[0]!.tier).toBe("team-40");
    expect(saved[0]!.seats).toBe(40);
    expect(saved[0]!.mode).toBe("live");
  });
});

describe("activate — fails closed, stores nothing", () => {
  it("rejects a forged signature (signed by a key we do not trust)", () => {
    const forged = mint({}, genPair().privateKey); // signed by someone else
    const saved: StoredLicense[] = [];
    const out = activateLicense(forged, { keys: key(publicPem), save: (s) => saved.push(s) });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("bad-signature");
    expect(saved).toHaveLength(0);
  });

  it("rejects a tampered payload (seat upgrade after signing)", () => {
    const license = mint({ tier: "team-10", seats: 10 });
    const [p, body, sig] = license.split(".");
    // Re-encode the payload with 40 seats but keep the old signature.
    const tampered = JSON.parse(Buffer.from(body!, "base64url").toString("utf8"));
    tampered.seats = 40;
    tampered.tier = "team-40";
    const forgedBody = Buffer.from(JSON.stringify(tampered), "utf8").toString("base64url");
    const out = activateLicense(`${p}.${forgedBody}.${sig}`, { keys: key(publicPem), save: () => { throw new Error("must not save"); } });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("bad-signature");
  });

  it("rejects an expired key", () => {
    const expired = mint({
      issuedAt: new Date(Date.now() - 60 * 86_400_000).toISOString(),
      expiresAt: new Date(Date.now() - 1 * 86_400_000).toISOString(),
    });
    const out = activateLicense(expired, { keys: key(publicPem), save: () => { throw new Error("must not save"); } });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("expired");
    expect(out.message).toMatch(/expired/i);
  });

  it("rejects a not-yet-valid key (issued well in the future)", () => {
    const future = mint({
      issuedAt: new Date(Date.now() + 10 * 86_400_000).toISOString(),
      expiresAt: new Date(Date.now() + 40 * 86_400_000).toISOString(),
    });
    const out = activateLicense(future, { keys: key(publicPem), save: () => { throw new Error("must not save"); } });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("not-yet-valid");
  });

  it("rejects a wrong prefix", () => {
    const license = mint().replace(/^RR1\./, "RR2.");
    const out = activateLicense(license, { keys: key(publicPem), save: () => { throw new Error("must not save"); } });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("bad-prefix");
  });

  it("rejects malformed junk", () => {
    const out = activateLicense("not-a-key", { keys: key(publicPem), save: () => { throw new Error("must not save"); } });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("malformed");
  });

  it("rejects an empty key", () => {
    const out = activateLicense("   ", { keys: key(publicPem), save: () => { throw new Error("must not save"); } });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("empty");
  });

  it("reports early-access when there are no trusted keys (pre-launch)", () => {
    const out = activateLicense(mint(), { keys: [], save: () => { throw new Error("must not save"); } });
    expect(out.ok).toBe(false);
    expect(out.reason).toBe("no-trusted-keys");
    expect(out.message).toMatch(/isn't live yet/i);
  });

  it("never throws on hostile input", () => {
    for (const bad of ["", ".", "RR1..", "RR1.x.y", "\u0000", "RR1." + "A".repeat(100000) + ".z"]) {
      expect(() => activateLicense(bad, { keys: key(publicPem), save: () => {} })).not.toThrow();
    }
  });
});

describe("entitlement store — re-verifies on read, fails closed", () => {
  let home: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "rr-ent-"));
    prevHome = process.env.HOME;
    process.env.HOME = home;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
  });

  it("round-trips a valid license and loads an active entitlement", () => {
    const license = mint({ tier: "team-40", seats: 40 });
    const out = activateLicense(license, { keys: key(publicPem) }); // real saveEntitlement → temp HOME
    expect(out.ok).toBe(true);
    expect(existsSync(entitlementPath())).toBe(true);
    const active = loadActiveEntitlement(new Date(), process.env, [publicPem]);
    expect(active).not.toBeNull();
    expect(active!.tier).toBe("team-40");
    expect(active!.seats).toBe(40);
  });

  it("stored fields are display-only — the SIGNED payload wins over a hand-edited JSON", () => {
    const license = mint({ tier: "team-10", seats: 10 });
    saveEntitlement({
      license,
      activatedAt: new Date().toISOString(),
      mode: "live",
      tier: "team-40", // liar: JSON says 40, the signed token says 10
      seats: 40,
      email: "x@y.com",
      orderId: "ord",
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    });
    const active = loadActiveEntitlement(new Date(), process.env, [publicPem]);
    expect(active).not.toBeNull();
    expect(active!.tier).toBe("team-10"); // from the signature, not the JSON
    expect(active!.seats).toBe(10);
  });

  it("returns null for a forged stored license", () => {
    const forged = mint({}, genPair().privateKey);
    saveEntitlement({
      license: forged,
      activatedAt: new Date().toISOString(),
      mode: "live",
      tier: "team-10",
      seats: 10,
      email: "x@y.com",
      orderId: "ord",
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    });
    expect(loadActiveEntitlement(new Date(), process.env, [publicPem])).toBeNull();
  });

  it("returns null once the stored license has expired", () => {
    const license = mint({
      issuedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
      expiresAt: new Date(Date.now() + 1 * 86_400_000).toISOString(),
    });
    activateLicense(license, { keys: key(publicPem) });
    const later = new Date(Date.now() + 5 * 86_400_000);
    expect(loadActiveEntitlement(later, process.env, [publicPem])).toBeNull();
  });

  it("clearEntitlement removes the stored license", () => {
    activateLicense(mint(), { keys: key(publicPem) });
    expect(existsSync(entitlementPath())).toBe(true);
    clearEntitlement();
    expect(existsSync(entitlementPath())).toBe(false);
    expect(loadStoredLicense()).toBeNull();
  });

  it("writes the license file owner-only (0600)", () => {
    activateLicense(mint(), { keys: key(publicPem) });
    const mode = statSync(entitlementPath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("verify helper parity", () => {
  it("a genuine key verifies under its own public key", () => {
    const res = verifyLicense(mint(), publicPem);
    expect(res.valid).toBe(true);
    expect(res.reason).toBe("ok");
  });
  it("the same key does NOT verify under a different public key", () => {
    const res = verifyLicense(mint(), otherPublicPem);
    expect(res.valid).toBe(false);
    expect(res.reason).toBe("bad-signature");
  });
});
