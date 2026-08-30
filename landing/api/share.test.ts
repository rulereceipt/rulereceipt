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

const { default: handler } = await import("./share.js");

beforeEach(() => {
  redisInstance._store.clear();
  redisInstance._sets.clear();
  vi.clearAllMocks();
});

describe("OPTIONS", () => {
  it("returns 204 with CORS headers", async () => {
    const { res, statusCode, headers } = mockRes();
    await handler(mockReq({ method: "OPTIONS" }), res);
    expect(statusCode()).toBe(204);
    expect(headers()["Access-Control-Allow-Origin"]).toBe("*");
  });
});

describe("payload size limit", () => {
  it("rejects a request over 2048 bytes with 413", async () => {
    const { res, statusCode } = mockRes();
    await handler(mockReq({ method: "POST", headers: { "content-length": "5000" } }), res);
    expect(statusCode()).toBe(413);
  });
});

describe("GET", () => {
  it("defaults every count to 0 before any run has been shared", async () => {
    const { res, statusCode, jsonBody } = mockRes();
    await handler(mockReq({ method: "GET" }), res);
    expect(statusCode()).toBe(200);
    expect(jsonBody()).toEqual({ total_runs: 0, total_pass: 0, total_fail: 0, total_unclear: 0 });
  });

  it("reflects real totals after a POST", async () => {
    await handler(
      mockReq({ method: "POST", body: { pass: 8, fail: 2, unclear: 1 } }),
      mockRes().res
    );
    const { res, jsonBody } = mockRes();
    await handler(mockReq({ method: "GET" }), res);
    expect(jsonBody()).toEqual({ total_runs: 1, total_pass: 8, total_fail: 2, total_unclear: 1 });
  });

  it("returns 429 once the GET rate limit (60/hr) is exceeded", async () => {
    for (let i = 0; i < 60; i++) {
      await handler(mockReq({ method: "GET" }), mockRes().res);
    }
    const { res, statusCode } = mockRes();
    await handler(mockReq({ method: "GET" }), res);
    expect(statusCode()).toBe(429);
  });
});

describe("unsupported methods", () => {
  it("rejects DELETE with 405", async () => {
    const { res, statusCode, jsonBody } = mockRes();
    await handler(mockReq({ method: "DELETE" }), res);
    expect(statusCode()).toBe(405);
    expect(jsonBody()).toEqual({ error: "method not allowed" });
  });
});

describe("POST validation", () => {
  it("rejects a negative count with 400", async () => {
    const { res, statusCode, jsonBody } = mockRes();
    await handler(mockReq({ method: "POST", body: { pass: -1, fail: 0, unclear: 0 } }), res);
    expect(statusCode()).toBe(400);
    expect(jsonBody()).toEqual({ error: "expected integer pass/fail/unclear counts" });
  });

  it("rejects a count over 1000 with 400", async () => {
    const { res, statusCode } = mockRes();
    await handler(mockReq({ method: "POST", body: { pass: 1001, fail: 0, unclear: 0 } }), res);
    expect(statusCode()).toBe(400);
  });

  it("rejects a non-integer count with 400", async () => {
    const { res, statusCode } = mockRes();
    await handler(mockReq({ method: "POST", body: { pass: 1.5, fail: 0, unclear: 0 } }), res);
    expect(statusCode()).toBe(400);
  });

  it("rejects a missing field with 400", async () => {
    const { res, statusCode } = mockRes();
    await handler(mockReq({ method: "POST", body: { pass: 1, fail: 0 } }), res);
    expect(statusCode()).toBe(400);
  });

  it("returns 429 once the POST rate limit (20/hr) is exceeded", async () => {
    for (let i = 0; i < 20; i++) {
      await handler(mockReq({ method: "POST", body: { pass: 1, fail: 0, unclear: 0 } }), mockRes().res);
    }
    const { res, statusCode } = mockRes();
    await handler(mockReq({ method: "POST", body: { pass: 1, fail: 0, unclear: 0 } }), res);
    expect(statusCode()).toBe(429);
  });
});

describe("POST success", () => {
  it("accepts valid counts and returns { ok: true }", async () => {
    const { res, statusCode, jsonBody } = mockRes();
    await handler(mockReq({ method: "POST", body: { pass: 5, fail: 1, unclear: 0 } }), res);
    expect(statusCode()).toBe(200);
    expect(jsonBody()).toEqual({ ok: true });
  });

  it("increments total_runs by exactly 1 per call, regardless of count sizes", async () => {
    await handler(mockReq({ method: "POST", body: { pass: 500, fail: 500, unclear: 0 } }), mockRes().res);
    expect(await redisInstance.get("rulereceipt:total_runs")).toBe(1);
  });
});
