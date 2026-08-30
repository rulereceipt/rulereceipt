import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockReq, mockRes, createMockRedis } from "./testUtils.js";

const redisInstance = createMockRedis();

vi.mock("@upstash/redis", () => ({
  Redis: vi.fn(() => redisInstance),
}));

process.env.KV_REST_API_URL = "https://fake.upstash.io";
process.env.KV_REST_API_TOKEN = "fake-token";

const { default: handler } = await import("./unsubscribe.js");

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
    expect(headers()["Access-Control-Allow-Origin"]).toBe("*");
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
      await handler(mockReq({ method: "POST", body: { email: `x${i}@example.com` } }), mockRes().res);
    }
    const { res, statusCode } = mockRes();
    await handler(mockReq({ method: "POST", body: { email: "one-too-many@example.com" } }), res);
    expect(statusCode()).toBe(429);
  });
});

describe("POST success — real removal", () => {
  it("actually removes a previously-signed-up email from the Redis set", async () => {
    await redisInstance.sadd("rulereceipt:signups", "real.user@example.com");
    expect(redisInstance._sets.get("rulereceipt:signups")?.has("real.user@example.com")).toBe(true);

    const { res, statusCode, jsonBody } = mockRes();
    await handler(mockReq({ method: "POST", body: { email: "  Real.User@Example.com  " } }), res);

    expect(statusCode()).toBe(200);
    expect(jsonBody()).toEqual({ ok: true });
    expect(redisInstance._sets.get("rulereceipt:signups")?.has("real.user@example.com")).toBe(false);
  });

  it("returns { ok: true } even for an email that was never on the list (no enumeration oracle)", async () => {
    const { res, statusCode, jsonBody } = mockRes();
    await handler(mockReq({ method: "POST", body: { email: "never-signed-up@example.com" } }), res);
    expect(statusCode()).toBe(200);
    expect(jsonBody()).toEqual({ ok: true });
  });

  it("does not remove unrelated emails from the set", async () => {
    await redisInstance.sadd("rulereceipt:signups", "keep-me@example.com");
    await redisInstance.sadd("rulereceipt:signups", "remove-me@example.com");

    const { res } = mockRes();
    await handler(mockReq({ method: "POST", body: { email: "remove-me@example.com" } }), res);

    expect(redisInstance._sets.get("rulereceipt:signups")?.has("keep-me@example.com")).toBe(true);
    expect(redisInstance._sets.get("rulereceipt:signups")?.has("remove-me@example.com")).toBe(false);
  });
});
