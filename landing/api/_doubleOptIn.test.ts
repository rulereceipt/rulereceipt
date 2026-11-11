import { describe, it, expect, vi } from "vitest";
import {
  makeToken,
  createPending,
  confirmToken,
  confirmEmailBody,
  sendConfirmEmail,
  doubleOptInEnabled,
  pendingKey,
  SIGNUPS_SET,
  type RedisLike,
  type FetchLike,
  type FetchResponseLike,
} from "./_doubleOptIn.js";

/**
 * Double opt-in logic, tested entirely offline with a Map-backed Redis and an
 * injected fetch. Guarantees:
 *   - a pending token is stored with a TTL and nothing is added to the real list;
 *   - confirming a live token adds the email and consumes the token (single use);
 *   - an unknown / expired / already-used token is rejected, never throws;
 *   - the confirmation email carries the link and no marketing/tracking;
 *   - double opt-in is OFF unless BOTH the flag and a Resend key are present.
 */

function mockRedis() {
  const kv = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  const r: RedisLike & { _kv: Map<string, string>; _sets: Map<string, Set<string>> } = {
    set: vi.fn(async (k: string, v: string) => { kv.set(k, v); }),
    get: vi.fn(async (k: string) => (kv.has(k) ? kv.get(k)! : null)),
    del: vi.fn(async (k: string) => { kv.delete(k); }),
    sadd: vi.fn(async (k: string, m: string) => { const s = sets.get(k) ?? new Set(); s.add(m); sets.set(k, s); return 1; }),
    sismember: vi.fn(async (k: string, m: string) => (sets.get(k)?.has(m) ? 1 : 0)),
    _kv: kv,
    _sets: sets,
  };
  return r;
}

function resp(p: Partial<FetchResponseLike> & { ok: boolean; status: number }): FetchResponseLike {
  return { text: async () => "", ...p };
}

describe("makeToken", () => {
  it("is URL-safe and unique", () => {
    const a = makeToken(), b = makeToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/); // base64url: no +, /, =
    expect(a.length).toBeGreaterThan(20);
  });
});

describe("createPending + confirmToken", () => {
  it("stores a pending token with a TTL and adds NOTHING to the list yet", async () => {
    const redis = mockRedis();
    const token = await createPending(redis, "User@Example.com".toLowerCase());
    expect(redis.set).toHaveBeenCalledWith(pendingKey(token), "user@example.com", { ex: expect.any(Number) });
    expect(redis._sets.get(SIGNUPS_SET)?.has("user@example.com") ?? false).toBe(false);
  });

  it("confirming a live token adds the email and consumes the token", async () => {
    const redis = mockRedis();
    const token = await createPending(redis, "a@b.com");
    const r = await confirmToken(redis, token);
    expect(r.ok).toBe(true);
    expect(r.email).toBe("a@b.com");
    expect(redis._sets.get(SIGNUPS_SET)?.has("a@b.com")).toBe(true);
    // single use: the token is gone
    expect(redis._kv.has(pendingKey(token))).toBe(false);
    const again = await confirmToken(redis, token);
    expect(again.ok).toBe(false);
    expect(again.reason).toBe("invalid-or-expired");
  });

  it("rejects an unknown or expired token without throwing", async () => {
    const redis = mockRedis();
    expect((await confirmToken(redis, "nope")).ok).toBe(false);
    expect((await confirmToken(redis, "")).ok).toBe(false);
    expect((await confirmToken(redis, undefined)).ok).toBe(false);
    expect(redis._sets.get(SIGNUPS_SET)?.size ?? 0).toBe(0);
  });
});

describe("confirmEmailBody", () => {
  it("carries the link and the expiry note, no marketing/tracking", () => {
    const { subject, text } = confirmEmailBody("https://rulereceipt.dev/api/confirm?token=abc");
    expect(subject).toMatch(/confirm/i);
    expect(text).toContain("https://rulereceipt.dev/api/confirm?token=abc");
    expect(text).toMatch(/expires in 48 hours/i);
    expect(text).toMatch(/ignore this email/i);
    expect(text).not.toMatch(/unsubscribe|<img|utm_|track|click here/i);
  });
});

describe("sendConfirmEmail", () => {
  it("POSTs to Resend with Bearer auth and the confirm link", async () => {
    const calls: Array<{ url: string; init: Parameters<FetchLike>[1] }> = [];
    const fetchImpl: FetchLike = async (url, init) => { calls.push({ url, init }); return resp({ ok: true, status: 200 }); };
    await sendConfirmEmail("a@b.com", "https://rulereceipt.dev/api/confirm?token=t", { apiKey: "re_x", from: "RuleReceipt <hello@rulereceipt.dev>" }, fetchImpl);
    expect(calls[0]!.url).toBe("https://api.resend.com/emails");
    expect(calls[0]!.init.headers.Authorization).toBe("Bearer re_x");
    const body = JSON.parse(calls[0]!.init.body);
    expect(body.to).toBe("a@b.com");
    expect(body.text).toContain("token=t");
  });

  it("throws on a non-2xx and when the key is missing", async () => {
    await expect(sendConfirmEmail("a@b.com", "u", { apiKey: "re_x", from: "f" }, async () => resp({ ok: false, status: 500 }))).rejects.toThrow(/500/);
    await expect(sendConfirmEmail("a@b.com", "u", { apiKey: "", from: "f" }, vi.fn() as unknown as FetchLike)).rejects.toThrow(/RESEND_API_KEY/);
  });
});

describe("doubleOptInEnabled", () => {
  it("is on only with BOTH the flag and a Resend key", () => {
    expect(doubleOptInEnabled({})).toBe(false);
    expect(doubleOptInEnabled({ SIGNUP_DOUBLE_OPT_IN: "1" })).toBe(false); // flag but no key -> off
    expect(doubleOptInEnabled({ RESEND_API_KEY: "re_x" })).toBe(false); // key but no flag -> off
    expect(doubleOptInEnabled({ SIGNUP_DOUBLE_OPT_IN: "1", RESEND_API_KEY: "re_x" })).toBe(true);
  });
});
