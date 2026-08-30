import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Redis } from "@upstash/redis";

// Receives only a random, non-identifying per-install ID from `rulereceipt
// check` (unless the user opted out via --no-telemetry / DO_NOT_TRACK /
// RULERECEIPT_NO_TELEMETRY). Never rule text, file paths, session content,
// or even pass/fail counts — that's what opt-in --share is for. Stored in a
// month-bucketed Redis Set so SCARD gives a real distinct-installs count,
// not just an event count.

const redis = new Redis({
  url: process.env.KV_REST_API_URL!,
  token: process.env.KV_REST_API_TOKEN!,
});

// UUIDs are 36 chars; a little slack for older/future ID formats without
// accepting arbitrary junk as a Redis set member.
const ID_SHAPE = /^[A-Za-z0-9-]{8,64}$/;

function isValidId(id: unknown): id is string {
  return typeof id === "string" && ID_SHAPE.test(id);
}

function clientIp(req: VercelRequest): string {
  const fwd = req.headers["x-forwarded-for"];
  const first = Array.isArray(fwd) ? fwd[0] : fwd;
  return (first ?? "").split(",")[0].trim() || "unknown";
}

async function rateLimited(req: VercelRequest, bucket: string, max: number): Promise<boolean> {
  const key = `rulereceipt:ratelimit:${bucket}:${clientIp(req)}`;
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, 3600);
  }
  return count > max;
}

function currentMonthKey(): string {
  const now = new Date();
  return `rulereceipt:telemetry:${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
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
    if (await rateLimited(req, "telemetry-get", 60)) {
      res.status(429).json({ error: "rate limit exceeded, try again later" });
      return;
    }
    const count = await redis.scard(currentMonthKey());
    res.status(200).json({ unique_installs_this_month: count ?? 0 });
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  if (await rateLimited(req, "telemetry-post", 30)) {
    res.status(429).json({ error: "rate limit exceeded, try again later" });
    return;
  }

  const body = req.body ?? {};
  const { id } = body as { id?: unknown };

  if (!isValidId(id)) {
    res.status(400).json({ error: "expected a valid id" });
    return;
  }

  await redis.sadd(currentMonthKey(), id);
  res.status(200).json({ ok: true });
}
