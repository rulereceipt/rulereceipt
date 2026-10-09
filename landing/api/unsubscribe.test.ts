import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockReq, mockRes, createMockRedis } from "./testUtils.js";

const redisInstance = createMockRedis();

vi.mock("@upstash/redis", () => ({
  // a regular function, not an arrow: this is called with `new`, and an
  // arrow function cannot be a constructor (vitest 4 surfaces this;
  // vitest 2 quietly tolerated it)
  Redis: vi.fn(function () {
    return redisInstance;
  }),
}));

process.env.KV_REST_API_URL = "https://fake.upstash.io";
process.env.KV_REST_API_TOKEN = "fake-token";
process.env.UNSUBSCRIBE_HMAC_SECRET = "test-unsubscribe-secret-0123456789";

const { default: handler, unsubscribeToken } = await import("./unsubscribe.js");

beforeEach(() => {
  redisInstance._store.clear();
  redisInstance._sets.clear();
  vi.clearAllMocks();
});

describe("OPTIONS", () => {
  it("returns 204 with CORS headers, no body", async () => {
    const { res, statusCode, headers } = mockRes();
    await handler(mockReq({ method: "OPTIONS" }), res);
    expect(statusCode()).toBe(204);
    expect(headers()["Access-Control-Allow-Origin"]).toBe("https://rulereceipt.dev");
  });
});

describe("payload size limit", () => {
  it("rejects a request over 2048 bytes with 413", async () => {
    const { res, statusCode, jsonBody } = mockRes();
    await handler(mockReq({ method: "POST", headers: { "content-length": "5000" } }), res);
    expect(statusCode()).toBe(413);
    expect(jsonBody()).toEqual({ error: "payload too large" });
  });
});

describe("unsupported methods", () => {
  it("rejects GET with 405 (unlike signup, this endpoint is POST-only)", async () => {
    const { res, statusCode, jsonBody } = mockRes();
    await handler(mockReq({ method: "GET" }), res);
    expect(statusCode()).toBe(405);
    expect(jsonBody()).toEqual({ error: "method not allowed" });
  });

  it("rejects PUT with 405", async () => {
    const { res, statusCode, jsonBody } = mockRes();
    await handler(mockReq({ method: "PUT" }), res);
    expect(statusCode()).toBe(405);
    expect(jsonBody()).toEqual({ error: "method not allowed" });
  });
});

describe("POST validation", () => {
  it("rejects a missing email with 400", async () => {
    const { res, statusCode, jsonBody } = mockRes();
    await handler(mockReq({ method: "POST", body: {} }), res);
    expect(statusCode()).toBe(400);
    expect(jsonBody()).toEqual({ error: "expected a valid email address" });
  });

  it("rejects a malformed email with 400", async () => {
    const { res, statusCode } = mockRes();
    await handler(mockReq({ method: "POST", body: { email: "not-an-email" } }), res);
    expect(statusCode()).toBe(400);
  });

  it("returns 429 once the rate limit (10/hr) is exceeded", async () => {
    for (let i = 0; i < 10; i++) {
      await handler(mockReq({ method: "POST", body: { email: `x${i}@example.com`, token: unsubscribeToken(`x${i}@example.com`) } }), mockRes().res);
    }
    const { res, statusCode } = mockRes();
    await handler(mockReq({ method: "POST", body: { email: "one-too-many@example.com", token: unsubscribeToken("one-too-many@example.com") } }), res);
    expect(statusCode()).toBe(429);
  });
});

describe("POST success — real removal (requires the email's valid HMAC token)", () => {
  it("removes a previously-signed-up email when the token is valid", async () => {
    await redisInstance.sadd("rulereceipt:signups", "real.user@example.com");
    expect(redisInstance._sets.get("rulereceipt:signups")?.has("real.user@example.com")).toBe(true);

    const { res, statusCode, jsonBody } = mockRes();
    // Token generated for the normalized form; the submitted email has padding/case.
    await handler(mockReq({ method: "POST", body: { email: "  Real.User@Example.com  ", token: unsubscribeToken("real.user@example.com") } }), res);

    expect(statusCode()).toBe(200);
    expect(jsonBody()).toEqual({ ok: true });
    expect(redisInstance._sets.get("rulereceipt:signups")?.has("real.user@example.com")).toBe(false);
  });

  it("returns { ok: true } for an email never on the list, with a valid token (no oracle)", async () => {
    const { res, statusCode, jsonBody } = mockRes();
    await handler(mockReq({ method: "POST", body: { email: "never@example.com", token: unsubscribeToken("never@example.com") } }), res);
    expect(statusCode()).toBe(200);
    expect(jsonBody()).toEqual({ ok: true });
  });
});

describe("POST security — no token means no removal (the 'anyone can unsubscribe anyone' fix)", () => {
  it("does NOT remove when the token is absent, and still returns { ok: true } (uniform, no oracle)", async () => {
    await redisInstance.sadd("rulereceipt:signups", "victim@example.com");
    const { res, statusCode, jsonBody } = mockRes();
    await handler(mockReq({ method: "POST", body: { email: "victim@example.com" } }), res); // no token
    expect(statusCode()).toBe(200);
    expect(jsonBody()).toEqual({ ok: true });
    expect(redisInstance._sets.get("rulereceipt:signups")?.has("victim@example.com")).toBe(true); // NOT removed
  });

  it("does NOT remove with a forged/wrong token", async () => {
    await redisInstance.sadd("rulereceipt:signups", "victim@example.com");
    const { res, statusCode } = mockRes();
    await handler(mockReq({ method: "POST", body: { email: "victim@example.com", token: "0".repeat(64) } }), res);
    expect(statusCode()).toBe(200);
    expect(redisInstance._sets.get("rulereceipt:signups")?.has("victim@example.com")).toBe(true); // NOT removed
  });

  it("does NOT remove with a token minted for a DIFFERENT email", async () => {
    await redisInstance.sadd("rulereceipt:signups", "victim@example.com");
    const { res } = mockRes();
    await handler(mockReq({ method: "POST", body: { email: "victim@example.com", token: unsubscribeToken("attacker@example.com") } }), res);
    expect(redisInstance._sets.get("rulereceipt:signups")?.has("victim@example.com")).toBe(true); // NOT removed
  });

  it("does not touch unrelated emails even with a valid token for the target", async () => {
    await redisInstance.sadd("rulereceipt:signups", "keep-me@example.com");
    await redisInstance.sadd("rulereceipt:signups", "remove-me@example.com");
    const { res } = mockRes();
    await handler(mockReq({ method: "POST", body: { email: "remove-me@example.com", token: unsubscribeToken("remove-me@example.com") } }), res);
    expect(redisInstance._sets.get("rulereceipt:signups")?.has("keep-me@example.com")).toBe(true);
    expect(redisInstance._sets.get("rulereceipt:signups")?.has("remove-me@example.com")).toBe(false);
  });
});
