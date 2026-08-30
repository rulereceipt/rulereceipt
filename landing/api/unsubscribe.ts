import type { VercelRequest, VercelResponse } from "./vercel-types.js";
import { Redis } from "@upstash/redis";

// Removes an email from the same signup list /api/signup.ts adds to
// (rulereceipt:signups). This is the real, automated deletion path referenced
// in privacy.html — without it, removal could only ever happen by someone
// manually running a Redis command by hand.

const redis = new Redis({
  url: process.env.KV_REST_API_URL!,
  token: process.env.KV_REST_API_TOKEN!,
});

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmail(email: unknown): email is string {
  return typeof email === "string" && email.length <= 254 && EMAIL_SHAPE.test(email.trim());
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

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
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

  if (req.method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  if (await rateLimited(req, "unsubscribe-post", 10)) {
    res.status(429).json({ error: "rate limit exceeded, try again later" });
    return;
  }

  const body = req.body ?? {};
  const { email } = body as { email?: unknown };

  if (!isValidEmail(email)) {
    res.status(400).json({ error: "expected a valid email address" });
    return;
  }

  const normalized = email.trim().toLowerCase();
  await redis.srem("rulereceipt:signups", normalized);

  // Same uniform-response reasoning as signup.ts: whether the email was
  // actually on the list is never revealed, so this can't be used to check
  // if a given address signed up.
  res.status(200).json({ ok: true });
}
