import type { VercelRequest, VercelResponse } from "./vercel-types.js";
import { redis, rateLimited, withRedis, tooLarge } from "./_shared.js";
import { doubleOptInEnabled, createPending, sendConfirmEmail } from "./_doubleOptIn.js";

// Optional "get early access / updates" email signup. Separate from the CLI
// entirely — running `rulereceipt check`/`demo` still requires no account and
// sends no data anywhere. This only captures an email when someone explicitly
// submits the signup form on the site.

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmail(email: unknown): email is string {
  return typeof email === "string" && email.length <= 254 && EMAIL_SHAPE.test(email.trim());
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
    // Count only — never expose the email list over this public endpoint.
    let total = 0;
    let limited = false;
    if (!(await withRedis(res, async () => {
      limited = await rateLimited(req, "signup-get", 60);
      if (!limited) total = (await redis.scard("rulereceipt:signups")) ?? 0;
    }))) return;
    if (limited) {
      res.status(429).json({ error: "rate limit exceeded, try again later" });
      return;
    }
    res.status(200).json({ total_signups: total });
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  let limited = false;
  if (!(await withRedis(res, async () => { limited = await rateLimited(req, "signup-post", 10); }))) return;
  if (limited) {
    res.status(429).json({ error: "rate limit exceeded, try again later" });
    return;
  }

  const body = req.body ?? {};
  const { email, company } = body as { email?: unknown; company?: unknown };

  // Honeypot: `company` is a hidden field real users never see or fill. A bot
  // that fills it is silently accepted (so it can't tell it was caught) but the
  // address is never stored. No error, no signal.
  if (typeof company === "string" && company.trim() !== "") {
    res.status(200).json({ ok: true });
    return;
  }

  if (!isValidEmail(email)) {
    res.status(400).json({ error: "expected a valid email address" });
    return;
  }

  const normalized = email.trim().toLowerCase();

  // Double opt-in (only when flagged AND Resend is configured): store a pending
  // token and email a confirm link instead of adding the address now. The
  // address joins the list only when the link is opened. An already-confirmed
  // address is skipped (no re-send). The HTTP response stays uniform either way,
  // so this is not an enumeration oracle.
  if (doubleOptInEnabled()) {
    if (!(await withRedis(res, async () => {
      const already = await redis.sismember("rulereceipt:signups", normalized);
      if (!already) {
        const token = await createPending(redis, normalized);
        const base = process.env.SITE_ORIGIN ?? "https://rulereceipt.dev";
        await sendConfirmEmail(
          normalized,
          `${base}/api/confirm?token=${token}`,
          { apiKey: process.env.RESEND_API_KEY ?? "", from: process.env.LICENSE_FROM_EMAIL ?? "RuleReceipt <hello@rulereceipt.dev>" }
        );
      }
    }))) return;
    res.status(200).json({ ok: true });
    return;
  }

  // Single opt-in (default until double opt-in is enabled).
  if (!(await withRedis(res, async () => { await redis.sadd("rulereceipt:signups", normalized); }))) return;

  // Uniform response regardless of whether this email was already present -
  // returning that as a distinct signal turns this into an email-enumeration
  // oracle (submit any address, learn if it's on the list).
  res.status(200).json({ ok: true });
}
