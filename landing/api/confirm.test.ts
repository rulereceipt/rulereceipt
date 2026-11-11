import { describe, it, expect, vi, beforeEach } from "vitest";
import { mockReq, mockRes, createMockRedis } from "./testUtils.js";
import { pendingKey, SIGNUPS_SET } from "./_doubleOptIn.js";

const redisInstance = createMockRedis();

vi.mock("@upstash/redis", () => ({
  Redis: vi.fn(function () { return redisInstance; }),
}));

process.env.KV_REST_API_URL = "https://fake.upstash.io";
process.env.KV_REST_API_TOKEN = "fake-token";

const { default: handler } = await import("./confirm.js");

beforeEach(() => {
  redisInstance._store.clear();
  redisInstance._sets.clear();
  vi.clearAllMocks();
});

describe("confirm endpoint", () => {
  it("rejects non-GET with 405", async () => {
    const { res, statusCode } = mockRes();
    await handler(mockReq({ method: "POST" }), res);
    expect(statusCode()).toBe(405);
  });

  it("a valid token confirms the address and redirects to the confirmed page", async () => {
    // seed a pending token -> email
    await redisInstance.set(pendingKey("tok123"), "buyer@example.com");
    const { res, statusCode, headers } = mockRes();
    await handler(mockReq({ method: "GET", query: { token: "tok123" } }), res);
    expect(statusCode()).toBe(302);
    expect(headers()["Location"]).toBe("/?confirmed=1");
    expect(redisInstance._sets.get(SIGNUPS_SET)?.has("buyer@example.com")).toBe(true);
    expect(redisInstance._store.has(pendingKey("tok123"))).toBe(false); // single use
  });

  it("an unknown/expired token redirects to the expired page and adds nothing", async () => {
    const { res, statusCode, headers } = mockRes();
    await handler(mockReq({ method: "GET", query: { token: "nope" } }), res);
    expect(statusCode()).toBe(302);
    expect(headers()["Location"]).toBe("/?confirm=expired");
    expect(redisInstance._sets.get(SIGNUPS_SET)?.size ?? 0).toBe(0);
  });

  it("a missing token is treated as expired, never throws", async () => {
    const { res, statusCode, headers } = mockRes();
    await handler(mockReq({ method: "GET" }), res);
    expect(statusCode()).toBe(302);
    expect(headers()["Location"]).toBe("/?confirm=expired");
  });
});
