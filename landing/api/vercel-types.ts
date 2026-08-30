/**
 * Minimal local definitions of the two Vercel handler types we use.
 *
 * These were previously imported from `@vercel/node`, which is a
 * types-only dependency here (every import is `import type`) but pulls in
 * undici, path-to-regexp, esbuild and their transitive trees — 20+ open
 * advisories at last count, for zero runtime code. Vercel supplies the
 * actual runtime in production; the package was only ever providing these
 * shapes at compile time.
 *
 * Deliberately narrow: this describes what our handlers actually touch,
 * not the full Vercel surface. If a handler needs another field, add it
 * here rather than reinstating the dependency.
 */
export interface VercelRequest {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  query?: Record<string, string | string[]>;
}

export interface VercelResponse {
  setHeader(name: string, value: string | number | readonly string[]): VercelResponse;
  status(code: number): VercelResponse;
  json(body: unknown): VercelResponse;
  send(body: unknown): VercelResponse;
  end(chunk?: unknown): VercelResponse;
}
