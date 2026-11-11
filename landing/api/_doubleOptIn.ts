// Double opt-in for the email signup. The leading underscore keeps Vercel from
// treating this as a routable function — it's a shared module.
//
// Single opt-in (today) stores the address straight away. Double opt-in instead
// stores a short-lived PENDING token, emails a confirmation link, and only adds
// the address to the real list when that link is opened. Nothing is added
// without a click, and an unconfirmed pending token EXPIRES on its own (TTL).
//
// This is gated by `doubleOptInEnabled`, which requires an explicit flag AND a
// Resend key — so it cannot switch on (and cannot break signups by asking for a
// confirmation that can never be sent) until Resend + DKIM are actually live.

import { randomBytes } from "node:crypto";

export const PENDING_TTL_SEC = 48 * 60 * 60; // 48 hours
export const SIGNUPS_SET = "rulereceipt:signups";
const pendingKey = (token: string): string => `rulereceipt:pending:${token}`;

/** Just the Redis calls this module makes — so a test can pass a tiny stand-in. */
export interface RedisLike {
  set(key: string, value: string, opts?: { ex?: number }): Promise<unknown>;
  get(key: string): Promise<unknown>;
  del(key: string): Promise<unknown>;
  sadd(key: string, member: string): Promise<unknown>;
  sismember(key: string, member: string): Promise<number>;
}

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string }
) => Promise<FetchResponseLike>;

/** A URL-safe, unguessable token. 32 bytes of entropy. */
export function makeToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Store a pending confirmation (token -> email) with a TTL. Returns the token. */
export async function createPending(
  redis: RedisLike,
  email: string,
  ttlSec: number = PENDING_TTL_SEC,
  token: string = makeToken()
): Promise<string> {
  await redis.set(pendingKey(token), email, { ex: ttlSec });
  return token;
}

export interface ConfirmResult {
  ok: boolean;
  email?: string;
  reason?: "invalid-or-expired";
}

/**
 * Confirm a token: if it still exists (not expired, not already used), add the
 * email to the real list and delete the token (single use). Otherwise report
 * invalid-or-expired. Never throws for a bad token.
 */
export async function confirmToken(redis: RedisLike, token: unknown): Promise<ConfirmResult> {
  if (typeof token !== "string" || token.length === 0) return { ok: false, reason: "invalid-or-expired" };
  const email = await redis.get(pendingKey(token));
  if (typeof email !== "string" || email.length === 0) return { ok: false, reason: "invalid-or-expired" };
  await redis.sadd(SIGNUPS_SET, email);
  await redis.del(pendingKey(token));
  return { ok: true, email };
}

/** The confirmation email — plain text, no marketing, no tracking. */
export function confirmEmailBody(confirmUrl: string): { subject: string; text: string } {
  const subject = "Confirm your RuleReceipt signup";
  const text = [
    "Thanks for signing up for RuleReceipt updates.",
    "",
    "Please confirm your email by opening this link:",
    "",
    `    ${confirmUrl}`,
    "",
    "The link expires in 48 hours. If you didn't sign up, just ignore this email —",
    "nothing is added to any list without this confirmation.",
    "",
    "— RuleReceipt",
  ].join("\n");
  return { subject, text };
}

/** Send the confirmation email via Resend. Throws on misconfig / non-2xx. */
export async function sendConfirmEmail(
  email: string,
  confirmUrl: string,
  env: { apiKey: string; from: string },
  fetchImpl: FetchLike = fetch as unknown as FetchLike
): Promise<void> {
  if (!env.apiKey) throw new Error("RESEND_API_KEY not set");
  const { subject, text } = confirmEmailBody(confirmUrl);
  const res = await fetchImpl("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.from, to: email, subject, text }),
  });
  if (!res.ok) {
    const b = await res.text().catch(() => "");
    throw new Error(`confirm email failed: HTTP ${res.status}${b ? ` — ${b.slice(0, 200)}` : ""}`);
  }
}

/**
 * Double opt-in is ON only when explicitly flagged AND a Resend key is present.
 * Both are required so the flow can never be half-on (asking for a confirmation
 * email it cannot send), which would silently break every signup.
 */
export function doubleOptInEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SIGNUP_DOUBLE_OPT_IN === "1" && Boolean(env.RESEND_API_KEY);
}

export { pendingKey };
