import type { VercelRequest, VercelResponse } from "./vercel-types.js";
import { Redis } from "@upstash/redis";

// Shared helpers for the KV API endpoints. The leading underscore makes Vercel
// treat this as a private module, NOT a routable serverless function. Centralised
// 2026-10-09 so the rate-limiter and its fixes live in ONE place instead of four
// drifting copies (the IP-spoofing fix had to be applied four times otherwise).

export const redis = new Redis({
  url: process.env.KV_REST_API_URL!,
  token: process.env.KV_REST_API_TOKEN!,
});

export function clientIp(req: VercelRequest): string {
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

export async function rateLimited(req: VercelRequest, bucket: string, max: number): Promise<boolean> {
  const key = `rulereceipt:ratelimit:${bucket}:${clientIp(req)}`;
  const count = await redis.incr(key);
  // Guarantee the key always carries a TTL. If the expire after the first incr
  // was ever dropped (a transient failure), the bucket would otherwise stay
  // incremented forever and permanently rate-limit a legitimate IP. Setting it
  // only when it is actually missing (ttl < 0) avoids resetting a valid window.
  if (count === 1) {
    await redis.expire(key, 3600);
  } else {
    const ttl = await redis.ttl(key);
    if (ttl < 0) await redis.expire(key, 3600);
  }
  return count > max;
}

/**
 * Run a block of Redis work, converting any backend failure into a clean generic
 * 503 (never a raw 500 with internal detail). A transient Upstash outage should
 * fail predictably, not in an undefined way. Returns true if it ran, false if it
 * failed and a 503 was already sent.
 */
export async function withRedis(res: VercelResponse, fn: () => Promise<void>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch {
    res.status(503).json({ error: "service temporarily unavailable, try again later" });
    return false;
  }
}

// Content-Length is advisory only: a chunked or falsified header defaults to 0 and
// passes, and Vercel has already parsed req.body before the handler runs, so this
// does not prevent parse cost. The real guards are per-field validation plus
// Vercel's platform body limit (~4.5MB). Kept as a cheap best-effort early-out.
export function tooLarge(req: VercelRequest, maxBytes = 2048): boolean {
  return Number(req.headers["content-length"] ?? 0) > maxBytes;
}
