import type { VercelRequest, VercelResponse } from "./vercel-types.js";
import { redis, rateLimited, withRedis, tooLarge } from "./_shared.js";

// Opt-in usage counter. Receives only aggregate PASS/FAIL/UNCLEAR counts from
// `rulereceipt check --share` — never rule text, file paths, or session content.
// The CLI makes zero network calls unless the user explicitly passes --share.

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1000;
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
    let out = { total_runs: 0, total_pass: 0, total_fail: 0, total_unclear: 0 };
    if (!(await withRedis(res, async () => {
      limited = await rateLimited(req, "get", 60);
      if (limited) return;
      const [runs, pass, fail, unclear] = await Promise.all([
        redis.get<number>("rulereceipt:total_runs"),
        redis.get<number>("rulereceipt:total_pass"),
        redis.get<number>("rulereceipt:total_fail"),
        redis.get<number>("rulereceipt:total_unclear"),
      ]);
      out = { total_runs: runs ?? 0, total_pass: pass ?? 0, total_fail: fail ?? 0, total_unclear: unclear ?? 0 };
    }))) return;
    if (limited) {
      res.status(429).json({ error: "rate limit exceeded, try again later" });
      return;
    }
    res.status(200).json(out);
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  let limited = false;
  if (!(await withRedis(res, async () => { limited = await rateLimited(req, "post", 20); }))) return;
  if (limited) {
    res.status(429).json({ error: "rate limit exceeded, try again later" });
    return;
  }

  const body = req.body ?? {};
  const { pass, fail, unclear } = body as { pass?: unknown; fail?: unknown; unclear?: unknown };

  if (!isCount(pass) || !isCount(fail) || !isCount(unclear)) {
    res.status(400).json({ error: "expected integer pass/fail/unclear counts" });
    return;
  }

  if (!(await withRedis(res, async () => {
    await Promise.all([
      redis.incr("rulereceipt:total_runs"),
      redis.incrby("rulereceipt:total_pass", pass),
      redis.incrby("rulereceipt:total_fail", fail),
      redis.incrby("rulereceipt:total_unclear", unclear),
    ]);
  }))) return;

  res.status(200).json({ ok: true });
}
