import type { VercelRequest, VercelResponse } from "./vercel-types.js";
import { vi } from "vitest";

export function mockReq(opts: {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}): VercelRequest {
  return {
    method: opts.method ?? "GET",
    headers: opts.headers ?? {},
    body: opts.body,
  } as unknown as VercelRequest;
}

export interface MockRes {
  res: VercelResponse;
  statusCode: () => number | undefined;
  jsonBody: () => unknown;
  headers: () => Record<string, string>;
}

export function mockRes(): MockRes {
  let statusCode: number | undefined;
  let jsonBody: unknown;
  const headers: Record<string, string> = {};

  const res = {
    setHeader: vi.fn((name: string, value: string) => {
      headers[name] = value;
    }),
    status: vi.fn((code: number) => {
      statusCode = code;
      return res;
    }),
    json: vi.fn((body: unknown) => {
      jsonBody = body;
      return res;
    }),
    end: vi.fn(() => res),
  } as unknown as VercelResponse;

  return {
    res,
    statusCode: () => statusCode,
    jsonBody: () => jsonBody,
    headers: () => headers,
  };
}

// In-memory stand-in for the Upstash Redis client, scoped to what
// signup.ts/share.ts actually call. Reset between tests via clear().
export function createMockRedis() {
  const store = new Map<string, number>();
  const sets = new Map<string, Set<string>>();

  return {
    incr: vi.fn(async (key: string) => {
      const next = (store.get(key) ?? 0) + 1;
      store.set(key, next);
      return next;
    }),
    expire: vi.fn(async () => 1),
    incrby: vi.fn(async (key: string, amount: number) => {
      const next = (store.get(key) ?? 0) + amount;
      store.set(key, next);
      return next;
    }),
    get: vi.fn(async (key: string) => (store.has(key) ? store.get(key) : null)),
    sadd: vi.fn(async (key: string, member: string) => {
      const set = sets.get(key) ?? new Set<string>();
      const added = set.has(member) ? 0 : 1;
      set.add(member);
      sets.set(key, set);
      return added;
    }),
    srem: vi.fn(async (key: string, member: string) => {
      const set = sets.get(key);
      if (!set || !set.has(member)) return 0;
      set.delete(member);
      return 1;
    }),
    scard: vi.fn(async (key: string) => sets.get(key)?.size ?? 0),
    _store: store,
    _sets: sets,
  };
}
