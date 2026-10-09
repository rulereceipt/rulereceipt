import type { VercelRequest, VercelResponse } from "./vercel-types.js";
import { redis, rateLimited, withRedis, tooLarge } from "./_shared.js";

// Receives only a random, non-identifying per-install ID from `rulereceipt
// check` (unless the user opted out via --no-telemetry / DO_NOT_TRACK /
// RULERECEIPT_NO_TELEMETRY). Never rule text, file paths, session content,
// or even pass/fail counts — that's what opt-in --share is for. Stored in a
// month-bucketed Redis Set so SCARD gives a real distinct-installs count,
// not just an event count.

// UUIDs are 36 chars; a little slack for older/future ID formats without
// accepting arbitrary junk as a Redis set member.
const ID_SHAPE = /^[A-Za-z0-9-]{8,64}$/;

function isValidId(id: unknown): id is string {
  return typeof id === "string" && ID_SHAPE.test(id);
}

function currentMonthKey(): string {
  const now = new Date();
  return `rulereceipt:telemetry:${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "https://rulereceipt.dev");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (tooLarge(req)) {
    res.status(413).json({ error: "payload too large" });
    return;
  }

  if (req.method === "GET") {
    let limited = false;
    let count = 0;
    if (!(await withRedis(res, async () => {
      limited = await rateLimited(req, "telemetry-get", 60);
      if (!limited) count = (await redis.scard(currentMonthKey())) ?? 0;
    }))) return;
    if (limited) {
      res.status(429).json({ error: "rate limit exceeded, try again later" });
      return;
    }
    res.status(200).json({ unique_installs_this_month: count });
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  let limited = false;
  if (!(await withRedis(res, async () => { limited = await rateLimited(req, "telemetry-post", 30); }))) return;
  if (limited) {
    res.status(429).json({ error: "rate limit exceeded, try again later" });
    return;
  }

  const body = req.body ?? {};
  const { id } = body as { id?: unknown };

  if (!isValidId(id)) {
    res.status(400).json({ error: "expected a valid id" });
    return;
  }

  if (!(await withRedis(res, async () => { await redis.sadd(currentMonthKey(), id); }))) return;
  res.status(200).json({ ok: true });
}
