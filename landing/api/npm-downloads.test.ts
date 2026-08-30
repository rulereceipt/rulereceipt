import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockReq, mockRes } from "./testUtils.js";

const { default: handler } = await import("./npm-downloads.js");

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("OPTIONS", () => {
  it("returns 204 with CORS headers, no body", async () => {
    const { res, statusCode, headers } = mockRes();
    await handler(mockReq({ method: "OPTIONS" }), res);
    expect(statusCode()).toBe(204);
    expect(headers()["Access-Control-Allow-Origin"]).toBe("*");
  });
});

describe("unsupported methods", () => {
  it("rejects POST with 405", async () => {
    const { res, statusCode, jsonBody } = mockRes();
    await handler(mockReq({ method: "POST" }), res);
    expect(statusCode()).toBe(405);
    expect(jsonBody()).toEqual({ error: "method not allowed" });
  });
});

describe("GET", () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  it("relays the real downloads count from npm's API", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ downloads: 412, start: "2026-07-31", end: "2026-08-29", package: "rulereceipt" }),
    });
    const { res, statusCode, jsonBody } = mockRes();
    await handler(mockReq({ method: "GET" }), res);
    expect(statusCode()).toBe(200);
    expect(jsonBody()).toEqual({ downloads: 412, period: "last-month" });
  });

  it("returns 502 when npm's API responds with an error status", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false });
    const { res, statusCode, jsonBody } = mockRes();
    await handler(mockReq({ method: "GET" }), res);
    expect(statusCode()).toBe(502);
    expect(jsonBody()).toEqual({ error: "npm registry unavailable" });
  });

  it("returns 502 when the fetch itself throws (network error, timeout)", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("timeout"));
    const { res, statusCode, jsonBody } = mockRes();
    await handler(mockReq({ method: "GET" }), res);
    expect(statusCode()).toBe(502);
    expect(jsonBody()).toEqual({ error: "npm registry unavailable" });
  });

  // proves this can actually fail: a malformed upstream response must not
  // be trusted as-is
  it("defaults to 0 when npm's response has no numeric downloads field", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ error: "package not found" }),
    });
    const { res, jsonBody } = mockRes();
    await handler(mockReq({ method: "GET" }), res);
    expect(jsonBody()).toEqual({ downloads: 0, period: "last-month" });
  });
});
