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

const { default: handler } = await import("./telemetry.js");

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
  it("rejects PUT with 405", async () => {
    const { res, statusCode, jsonBody } = mockRes();
    await handler(mockReq({ method: "PUT" }), res);
    expect(statusCode()).toBe(405);
    expect(jsonBody()).toEqual({ error: "method not allowed" });
  });
});

describe("POST validation", () => {
  it("rejects a missing id with 400", async () => {
    const { res, statusCode, jsonBody } = mockRes();
    await handler(mockReq({ method: "POST", body: {} }), res);
    expect(statusCode()).toBe(400);
    expect(jsonBody()).toEqual({ error: "expected a valid id" });
  });

  it("rejects an id that's too short (guards against junk/placeholder values)", async () => {
    const { res, statusCode } = mockRes();
    await handler(mockReq({ method: "POST", body: { id: "x" } }), res);
    expect(statusCode()).toBe(400);
  });

  it("rejects an id containing suspicious characters", async () => {
    const { res, statusCode } = mockRes();
    await handler(mockReq({ method: "POST", body: { id: "not a uuid; rm -rf" } }), res);
    expect(statusCode()).toBe(400);
  });

  it("accepts a real-shaped UUID", async () => {
    const { res, statusCode, jsonBody } = mockRes();
    await handler(mockReq({ method: "POST", body: { id: "3fa85f64-5717-4562-b3fc-2c963f66afa6" } }), res);
    expect(statusCode()).toBe(200);
    expect(jsonBody()).toEqual({ ok: true });
  });

  it("returns 429 once the POST rate limit (30/hr) is exceeded", async () => {
    for (let i = 0; i < 30; i++) {
      await handler(mockReq({ method: "POST", body: { id: `3fa85f64-5717-4562-b3fc-2c963f66af${String(i).padStart(2, "0")}` } }), mockRes().res);
    }
    const { res, statusCode } = mockRes();
    await handler(mockReq({ method: "POST", body: { id: "3fa85f64-5717-4562-b3fc-2c963f66afff" } }), res);
    expect(statusCode()).toBe(429);
  });
});

describe("GET — real distinct-install counting", () => {
  it("counts each distinct id only once, even if sent multiple times", async () => {
    const sameId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
    await handler(mockReq({ method: "POST", body: { id: sameId } }), mockRes().res);
    await handler(mockReq({ method: "POST", body: { id: sameId } }), mockRes().res);
    await handler(mockReq({ method: "POST", body: { id: sameId } }), mockRes().res);

    const { res, jsonBody } = mockRes();
    await handler(mockReq({ method: "GET" }), res);
    expect(jsonBody()).toEqual({ unique_installs_this_month: 1 });
  });

  it("counts multiple distinct ids correctly", async () => {
    await handler(mockReq({ method: "POST", body: { id: "3fa85f64-5717-4562-b3fc-2c963f66af01" } }), mockRes().res);
    await handler(mockReq({ method: "POST", body: { id: "3fa85f64-5717-4562-b3fc-2c963f66af02" } }), mockRes().res);

    const { res, jsonBody } = mockRes();
    await handler(mockReq({ method: "GET" }), res);
    expect(jsonBody()).toEqual({ unique_installs_this_month: 2 });
  });

  it("returns 0 when no telemetry has been recorded yet", async () => {
    const { res, jsonBody } = mockRes();
    await handler(mockReq({ method: "GET" }), res);
    expect(jsonBody()).toEqual({ unique_installs_this_month: 0 });
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
