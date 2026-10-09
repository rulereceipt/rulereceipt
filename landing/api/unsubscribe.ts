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
  // Vercel sets x-real-ip to the true client IP and OVERWRITES any caller value,
  // so it can't be spoofed to dodge the rate limit. Prefer it. Fall back to the
  // RIGHTMOST x-forwarded-for entry (appended by the trusted proxy), NEVER the
  // leftmost — the leftmost is caller-controlled, so keying on it let an attacker
  // rotate buckets with a forged header and bypass the limit entirely.
  const real = req.headers["x-real-ip"];
  const realIp = (Array.isArray(real) ? real[0] : real)?.trim();
  if (realIp) return realIp;
  const fwd = req.headers["x-forwarded-for"];
  const fwdStr = Array.isArray(fwd) ? fwd[fwd.length - 1] : fwd;
  const parts = (fwdStr ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "unknown";
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
  res.setHeader("Access-Control-Allow-Origin", "https://rulereceipt.dev");
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
