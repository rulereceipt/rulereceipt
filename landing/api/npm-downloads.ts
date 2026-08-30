import type { VercelRequest, VercelResponse } from "./vercel-types.js";

// Server-side proxy for npm's public download-count API. Two reasons this
// isn't a direct client-side fetch to api.npmjs.org: (1) it would require
// widening the site's CSP connect-src to a third-party domain just for a
// vanity number, (2) this lets Vercel's CDN cache the response so every
// page load doesn't hit npm's API directly.
//
// This number is downloads, not users — npm counts every install/npx call,
// including CI pipelines and automated security scanners that hit every
// newly-published package regardless of real usage. stats.html labels it
// accordingly; this endpoint just relays the raw figure honestly.
const NPM_DOWNLOADS_URL = "https://api.npmjs.org/downloads/point/last-month/rulereceipt";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "GET") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  try {
    const npmRes = await fetch(NPM_DOWNLOADS_URL, { signal: AbortSignal.timeout(5000) });
    if (!npmRes.ok) {
      res.status(502).json({ error: "npm registry unavailable" });
      return;
    }
    const data = (await npmRes.json()) as { downloads?: unknown };
    const downloads = typeof data.downloads === "number" ? data.downloads : 0;
    res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=86400");
    res.status(200).json({ downloads, period: "last-month" });
  } catch {
    res.status(502).json({ error: "npm registry unavailable" });
  }
}
