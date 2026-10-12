import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Zero-network proof (correctness-program): plain `rulereceipt check` must make
 * no network calls. Rather than trust a claim, this RECORDS every outbound
 * attempt — DNS lookup, socket connect, http/https request, and fetch — via a
 * preload shim, runs the real built CLI over a fixture session, and asserts the
 * recorder is empty. If anything ever phones home by default, this fails with
 * the host it tried to reach.
 */
const CLI = resolve(__dirname, "..", "dist", "cli.js");
let dir: string;
let shim: string;
let netlog: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "rr-zeronet-"));
  netlog = join(dir, "netlog.txt");
  shim = join(dir, "net-recorder.cjs");
  // Records any outbound attempt to NETLOG. Localhost is still recorded (there
  // should be none at all for a plain check).
  writeFileSync(
    shim,
    `
const fs = require("fs");
const log = (what) => { try { fs.appendFileSync(process.env.NETLOG, what + "\\n"); } catch {} };
try { const dns = require("dns");
  for (const k of ["lookup","resolve","resolve4","resolve6"]) if (dns[k]) { const o = dns[k]; dns[k] = (...a) => { log("dns." + k + " " + a[0]); return o(...a); }; }
  if (dns.promises && dns.promises.lookup) { const o = dns.promises.lookup; dns.promises.lookup = (...a) => { log("dns.promises.lookup " + a[0]); return o(...a); }; }
} catch {}
try { const net = require("net"); const o = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...a) { try { log("net.connect " + JSON.stringify(a[0])); } catch { log("net.connect"); } return o.apply(this, a); };
} catch {}
for (const mod of ["http","https"]) { try { const m = require(mod); const o = m.request; m.request = (...a) => { log(mod + ".request " + (typeof a[0] === "string" ? a[0] : JSON.stringify(a[0]))); return o(...a); }; } catch {} }
try { if (globalThis.fetch) { const o = globalThis.fetch; globalThis.fetch = (...a) => { log("fetch " + a[0]); return o(...a); }; } } catch {}
`
  );

  // A minimal real project: a rule + a Claude-format session that violates it.
  writeFileSync(join(dir, "CLAUDE.md"), "# Rules\n\n## 1. No push to main\nNever push to the `main` branch.\n");
  const session = join(dir, "session.jsonl");
  const line = (o: unknown) => JSON.stringify(o);
  writeFileSync(
    session,
    [
      line({ type: "user", cwd: dir, message: { role: "user", content: "ship it" }, timestamp: "2026-10-12T00:00:00Z" }),
      line({ type: "assistant", cwd: dir, message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "git push origin main" } }] }, timestamp: "2026-10-12T00:00:01Z" }),
    ].join("\n")
  );
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("plain `check` makes zero network calls", () => {
  it("records no DNS / connect / request / fetch during a real check", () => {
    let out = "";
    let code = 0;
    try {
      out = execFileSync("node", ["--require", shim, CLI, "check", "--transcript", join(dir, "session.jsonl")], {
        cwd: dir,
        encoding: "utf-8",
        env: { ...process.env, NETLOG: netlog, RULERECEIPT_DISABLE_UPDATE_CHECK: "", NO_COLOR: "1" },
      });
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; status?: number };
      out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
      code = typeof e.status === "number" ? e.status : -1;
    }
    // The check must actually have run (produced a verdict), not no-op'd out early.
    expect(out.length, "check produced no output").toBeGreaterThan(0);
    // Exit is 0 (clean) or 1 (a FAIL was found) — both mean the check ran. A
    // crash/other code would mean it did not complete.
    expect([0, 1]).toContain(code);
    // The whole point: nothing reached the network.
    const attempts = existsSync(netlog) ? readFileSync(netlog, "utf-8").trim() : "";
    expect(attempts, `check attempted network:\n${attempts}`).toBe("");
  });
});
