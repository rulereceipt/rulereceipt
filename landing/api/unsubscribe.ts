import type { VercelRequest, VercelResponse } from "./vercel-types.js";
import { createHmac, timingSafeEqual } from "node:crypto";
import { redis, rateLimited, withRedis, tooLarge } from "./_shared.js";

// Removes an email from the signup list /api/signup.ts adds to
// (rulereceipt:signups) — the automated deletion path referenced in privacy.html.
//
// Security (2026-10-09): removal now requires a per-email HMAC token that only
// the recipient's own unsubscribe link carries. Before this, anyone who knew (or
// harvested) an address could POST it and silently remove that person. The token
// is HMAC-SHA256(secret, normalized-email); the secret lives only in the Vercel
// env (UNSUBSCRIBE_HMAC_SECRET, production), never in the repo. A request with no
// valid token removes NOTHING, and the response is uniform either way so it is
// still not an enumeration oracle. Old links with no token are handled by the
// confirm page (unsubscribe.html), which routes them to a manual request.

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmail(email: unknown): email is string {
  return typeof email === "string" && email.length <= 254 && EMAIL_SHAPE.test(email.trim());
}

/** The unsubscribe token for an email: HMAC-SHA256(secret, normalized-email), hex.
 * Exported so the email-sending flow (and tests) build the same link token. */
export function unsubscribeToken(email: string): string {
  const secret = process.env.UNSUBSCRIBE_HMAC_SECRET ?? "";
  return createHmac("sha256", secret).update(email.trim().toLowerCase()).digest("hex");
}

/** Constant-time check that `token` is the valid unsubscribe token for `email`.
 * Fails closed when the secret is unset or the shapes don't match. */
export function verifyUnsubscribeToken(email: string, token: unknown): boolean {
  if (!process.env.UNSUBSCRIBE_HMAC_SECRET) return false; // no secret -> nothing verifies
  if (typeof token !== "string" || !/^[0-9a-f]{64}$/i.test(token)) return false;
  const expected = Buffer.from(unsubscribeToken(email), "hex");
  const given = Buffer.from(token.toLowerCase(), "hex");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "https://rulereceipt.dev");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (tooLarge(req)) {
    res.status(413).json({ error: "payload too large" });
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  let limited = false;
  if (!(await withRedis(res, async () => { limited = await rateLimited(req, "unsubscribe-post", 10); }))) return;
  if (limited) {
    res.status(429).json({ error: "rate limit exceeded, try again later" });
    return;
  }

  const body = req.body ?? {};
  const { email, token } = body as { email?: unknown; token?: unknown };

  if (!isValidEmail(email)) {
    res.status(400).json({ error: "expected a valid email address" });
    return;
  }

  // Remove ONLY when the request carries this email's valid token. A tokenless or
  // forged request removes nothing — closing the "anyone can unsubscribe anyone"
  // hole — but the response below is uniform regardless, so it reveals neither
  // whether the email was on the list nor whether the token was valid.
  if (verifyUnsubscribeToken(email, token)) {
    const normalized = email.trim().toLowerCase();
    if (!(await withRedis(res, async () => { await redis.srem("rulereceipt:signups", normalized); }))) return;
  }

  res.status(200).json({ ok: true });
}
