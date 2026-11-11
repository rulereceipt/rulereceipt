import type { VercelRequest, VercelResponse } from "./vercel-types.js";
import { redis, rateLimited, withRedis } from "./_shared.js";
import { confirmToken } from "./_doubleOptIn.js";

// Double opt-in confirmation endpoint. Opened from the link in the confirmation
// email (GET ?token=...). A valid, unexpired token adds the address to the list;
// anything else is treated as expired. Redirects to a friendly page either way,
// and never echoes the token back.

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  let limited = false;
  if (!(await withRedis(res, async () => { limited = await rateLimited(req, "confirm", 30); }))) return;
  if (limited) {
    res.status(429).json({ error: "rate limit exceeded, try again later" });
    return;
  }

  const q = req.query ?? {};
  const raw = q.token;
  const token = typeof raw === "string" ? raw : Array.isArray(raw) ? raw[0] : "";

  let ok = false;
  if (!(await withRedis(res, async () => { ok = (await confirmToken(redis, token)).ok; }))) return;

  // A click in an email → redirect to a page, not JSON. No token in the target.
  res.setHeader("Location", ok ? "/?confirmed=1" : "/?confirm=expired");
  res.status(302).end();
}
