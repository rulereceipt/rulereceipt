import type { VercelRequest, VercelResponse } from "./vercel-types.js";
import { Redis } from "@upstash/redis";

// Opt-in usage counter. Receives only aggregate PASS/FAIL/UNCLEAR counts from
// `rulereceipt check --share` — never rule text, file paths, or session content.
// The CLI makes zero network calls unless the user explicitly passes --share.

// Vercel's marketplace Redis connector sets KV_-prefixed vars, not the
// UPSTASH_REDIS_REST_* names Redis.fromEnv() looks for — confirmed via
// `vercel env ls` against the real connected database, not assumed.
const redis = new Redis({
  url: process.env.KV_REST_API_URL!,
  token: process.env.KV_REST_API_TOKEN!,
});

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1000;
}

function clientIp(req: VercelRequest): string {
  const fwd = req.headers["x-forwarded-for"];
  const first = Array.isArray(fwd) ? fwd[0] : fwd;
  return (first ?? "").split(",")[0].trim() || "unknown";
}

// Fixed-window rate limit, keyed by IP, stored in the same Redis instance.
// Generous enough for real repeated use (many `check --share` runs a day),
// tight enough to block scripted counter inflation. Confirmed via the
// security audit that the endpoint had zero throttling before this.
async function rateLimited(req: VercelRequest, bucket: string, max: number): Promise<boolean> {
  const key = `rulereceipt:ratelimit:${bucket}:${clientIp(req)}`;
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, 3600);
  }
  return count > max;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  const contentLength = Number(req.headers["content-length"] ?? 0);
  if (contentLength > 2048) {
    res.status(413).json({ error: "payload too large" });
    return;
  }

  if (req.method === "GET") {
    if (await rateLimited(req, "get", 60)) {
      res.status(429).json({ error: "rate limit exceeded, try again later" });
      return;
    }
    const [runs, pass, fail, unclear] = await Promise.all([
      redis.get<number>("rulereceipt:total_runs"),
      redis.get<number>("rulereceipt:total_pass"),
      redis.get<number>("rulereceipt:total_fail"),
      redis.get<number>("rulereceipt:total_unclear"),
    ]);
    res.status(200).json({
      total_runs: runs ?? 0,
      total_pass: pass ?? 0,
      total_fail: fail ?? 0,
      total_unclear: unclear ?? 0,
    });
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  if (await rateLimited(req, "post", 20)) {
    res.status(429).json({ error: "rate limit exceeded, try again later" });
    return;
  }

  const body = req.body ?? {};
  const { pass, fail, unclear } = body as { pass?: unknown; fail?: unknown; unclear?: unknown };

  if (!isCount(pass) || !isCount(fail) || !isCount(unclear)) {
    res.status(400).json({ error: "expected integer pass/fail/unclear counts" });
    return;
  }

  await Promise.all([
    redis.incr("rulereceipt:total_runs"),
    redis.incrby("rulereceipt:total_pass", pass),
    redis.incrby("rulereceipt:total_fail", fail),
    redis.incrby("rulereceipt:total_unclear", unclear),
  ]);

  res.status(200).json({ ok: true });
}
