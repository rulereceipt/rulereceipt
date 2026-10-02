/**
 * Team plan — the ONE place the checkout link and its feature flag live, read by
 * the CLI (the landing pages mirror these exact values; keep them in sync).
 *
 * OPEN-CORE: this file holds only a LINK, a flag, and copy — never any paid-tier
 * LOGIC. Real licence/key validation and the hosted team service live in the
 * separate PRIVATE repo. `activate` here does not validate or unlock anything;
 * while the flag is off it only points at early access.
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

/** What `rulereceipt activate <key>` prints. No validation here — that is the private tier. */
export function activateNote(key: string): string {
  const masked = key.length > 6 ? `${key.slice(0, 3)}…${key.slice(-2)}` : "(key)";
  if (!TEAM_PLAN.live) {
    return `Team plan is in early access — nothing to activate yet. Contact ${TEAM_PLAN.contact} and we'll set you up.`;
  }
  return (
    `Thanks for subscribing. Key ${masked} noted.\n` +
    `Activation and the hosted team features are handled by the Team service (see rulereceipt.dev/thanks).\n` +
    `Manage your subscription: ${TEAM_PLAN.portalUrl || TEAM_PLAN.contact}`
  );
}
