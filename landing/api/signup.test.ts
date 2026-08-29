import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockReq, mockRes, createMockRedis } from "./testUtils.js";

const redisInstance = createMockRedis();

vi.mock("@upstash/redis", () => ({
  Redis: vi.fn(() => redisInstance),
}));

process.env.KV_REST_API_URL = "https://fake.upstash.io";
process.env.KV_REST_API_TOKEN = "fake-token";

const { default: handler } = await import("./signup.js");

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

describe("GET", () => {
  it("returns total_signups as a count only, never the raw list", async () => {
    await redisInstance.sadd("rulereceipt:signups", "a@example.com");
    await redisInstance.sadd("rulereceipt:signups", "b@example.com");
    const { res, statusCode, jsonBody } = mockRes();
    await handler(mockReq({ method: "GET" }), res);
    expect(statusCode()).toBe(200);
    expect(jsonBody()).toEqual({ total_signups: 2 });
  });

  it("returns 0 when no one has signed up yet", async () => {
    const { res, jsonBody } = mockRes();
    await handler(mockReq({ method: "GET" }), res);
    expect(jsonBody()).toEqual({ total_signups: 0 });
  });

  it("returns 429 once the GET rate limit (60/hr) is exceeded", async () => {
    for (let i = 0; i < 60; i++) {
      await handler(mockReq({ method: "GET" }), mockRes().res);
    }
    const { res, statusCode, jsonBody } = mockRes();
    await handler(mockReq({ method: "GET" }), res);
    expect(statusCode()).toBe(429);
    expect(jsonBody()).toEqual({ error: "rate limit exceeded, try again later" });
  });
});

describe("unsupported methods", () => {
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

  it("rejects an email over 254 characters with 400", async () => {
    const { res, statusCode } = mockRes();
    const longEmail = "a".repeat(250) + "@x.co";
    await handler(mockReq({ method: "POST", body: { email: longEmail } }), res);
    expect(statusCode()).toBe(400);
  });

  it("returns 429 once the POST rate limit (10/hr) is exceeded", async () => {
    for (let i = 0; i < 10; i++) {
      await handler(mockReq({ method: "POST", body: { email: `x${i}@example.com` } }), mockRes().res);
    }
    const { res, statusCode } = mockRes();
    await handler(mockReq({ method: "POST", body: { email: "one-too-many@example.com" } }), res);
    expect(statusCode()).toBe(429);
  });
});

describe("POST success", () => {
  it("accepts a valid email, stores it lowercased/trimmed, returns { ok: true }", async () => {
    const { res, statusCode, jsonBody } = mockRes();
    await handler(mockReq({ method: "POST", body: { email: "  Real.User@Example.com  " } }), res);
    expect(statusCode()).toBe(200);
    expect(jsonBody()).toEqual({ ok: true });
    expect(redisInstance._sets.get("rulereceipt:signups")?.has("real.user@example.com")).toBe(true);
  });
});

describe("email-enumeration regression (real fix, 2026-08-28)", () => {
  it("returns an IDENTICAL response for a brand-new email and an already-registered one", async () => {
    const { res: res1, statusCode: status1, jsonBody: body1 } = mockRes();
    await handler(mockReq({ method: "POST", body: { email: "repeat@example.com" } }), res1);

    const { res: res2, statusCode: status2, jsonBody: body2 } = mockRes();
    await handler(mockReq({ method: "POST", body: { email: "repeat@example.com" } }), res2);

    expect(status1()).toBe(status2());
    expect(body1()).toEqual(body2());
    expect(body1()).toEqual({ ok: true });
  });

  it("never includes an already_registered field in the response, regardless of membership", async () => {
    const { res, jsonBody } = mockRes();
    await handler(mockReq({ method: "POST", body: { email: "checked@example.com" } }), res);
    expect(jsonBody()).not.toHaveProperty("already_registered");
  });
});
