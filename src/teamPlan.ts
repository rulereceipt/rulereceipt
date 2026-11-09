/**
 * Team plan — the ONE place the checkout link and its feature flag live, read by
 * the CLI (the landing pages mirror these exact values; keep them in sync).
 *
 * OPEN-CORE: this file holds only a LINK, a flag, and copy — never any paid-tier
 * LOGIC. Offline licence VERIFICATION (public key only, verify-only) lives in
 * `src/license/` and backs `rulereceipt activate`; SIGNING/issuance, the webhook
 * and the hosted team service live in the separate PRIVATE repo. No private key
 * or paid-tier logic is in this repo.
 *
 * TEAM_CHECKOUT_LIVE stays `false` until Polar setup is done and a test purchase
 * works. While false, every surface shows "early access, contact …" and no
 * checkout/activate link is shown. Flip the flag AND fill `checkoutUrl`/
 * `portalUrl` together (and mirror them on the landing pages), then rebuild.
 */
export const TEAM_PLAN = {
  live: false,
  /** Polar checkout URL — filled in when going live. Empty while not live. */
  checkoutUrl: "",
  /** Polar customer portal (manage subscription) — shown on /thanks when live. */
  portalUrl: "",
  contact: "hello@rulereceipt.dev",
  trialDays: 14,
} as const;

/** The one-line Team-plan note for CLI output, flag-aware. */
export function teamPlanNote(): string {
  if (TEAM_PLAN.live && TEAM_PLAN.checkoutUrl) {
    return (
      `Team plan (trends over time, history, cross-repo dashboards): ` +
      `start a ${TEAM_PLAN.trialDays}-day free trial — ${TEAM_PLAN.checkoutUrl}\n` +
      `Already bought a seat? Run \`rulereceipt activate <key>\`.`
    );
  }
  return `Team plan (trends over time, history, cross-repo dashboards): early access — contact ${TEAM_PLAN.contact}.`;
}
