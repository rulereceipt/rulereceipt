# REUSE — third-party code we may reuse, and under what terms

RuleReceipt is source-available and ships a small, auditable package. When we
reuse open-source code we copy a **small, well-tested** piece into our own
adapter/check layer rather than take a large dependency, and we keep the
attribution and licence notice.

## Policy
- **Reuse only** MIT / Apache-2.0 / BSD-2/3 / ISC / 0BSD. Verified from the
  actual LICENSE file, not a badge.
- **Never** copy AGPL / GPL / LGPL / unlicensed / "source-available" /
  Commons-Clause / the OpenAI-Anthropic *rider* code. These are reference-only
  (read to learn a format), never lifted. See the flagged list below.
- The moment any code is ported: add the credit + licence notice to `NOTICE.md`
  **and** the ported file's header, and run `node scripts/license-gate.mjs`.

## Status as of 2026-10-10
**No third-party code has been ported.** Every shipped adapter is our own code. Where
another MIT-licensed project *documented* an agent's on-disk session format, we wrote our
reader with reference to that documentation (format knowledge, not copied code) and credit
the project in NOTICE.md; where we reverse-engineered the format from a real session
ourselves, no third party is involved. The only "reuse" is our own earlier forks (agnix,
rulesync, deja-vu), untouched. Claude Code plus seven more agents now have shipped,
validated session readers (see "Ported adapters" below); this file remains the plan for any
*actual* code reuse (secret-masking widen, health-check lint), each flipping to "ported"
with a NOTICE line if it ever lands.

## Production dependencies (confirmed from package.json)
Direct (3): `@anthropic-ai/sdk ~0.126.0`, `commander ~15.0.0`, `nodemailer ~10.0.1`.
Full resolved production tree: **10** packages, all permissively licensed
(`scripts/license-gate.mjs` passes). The judge (`@anthropic-ai/sdk`) and email
(`nodemailer`) are only used on opt-in paths; plain `check` uses neither.

## A. Session readers (per agent) — reuse candidates (MIT)
| Agent | Reuse for format | Repo | Licence | Plan |
|---|---|---|---|---|
| Copilot CLI | `events.jsonl` shape | gsemet/copilot-session-usage | MIT (file-verified) | port reader, credit |
| Copilot (VS Code export) | exported-session JSON | peckjon/copilot-chat-to-markdown | MIT | reference for the export shape |
| Codex | rollout JSONL cross-check | masonc15/codex-transcript-viewer | MIT | cross-check our codex adapter on edge cases |
| Claude Code | JSONL edge cases | daaain/claude-code-log, ccusage/ccusage | MIT | cross-check only (our reader ships) |
| OpenCode | 3-dir JSON join | **port from deja-vu** (see B) | MIT | port reader with credit |

> Note: these readers were ultimately written as our own code with reference to documented
> formats (credited in NOTICE.md), not code-ported — see "Ported adapters" below.

## B. deja-vu (MIT) — readers + secret masking
`vshulcz/deja-vu`, MIT (file-verified). May port: its OpenCode session reader and
its **secret-masking patterns**, with credit in NOTICE + file header. (Our
`src/wrong.ts` already has independent masking; deja-vu's patterns may widen it.)

## C. rulesync (MIT) — rules-file locations + precedence
`rulesync`, MIT. Reference for where each agent loads its rules files and the real
precedence, to make our rules-file loading complete per agent (CLAUDE.md,
AGENTS.md, .cursor/rules, copilot-instructions, GEMINI.md, .clinerules, …).

## D. agnix (MIT/Apache) — optional lint add-on
Optional reference/add-on for the rules-file **health check** (pre-flight lint).
**Not** a core dependency — the session check is the product; health lint is a
small separate, deterministic pre-flight.

## E. tree-sitter-bash (MIT) — shell parsing (EVALUATED, declined)
Evaluated and **not adopted**: our regex `segments()`/`leadingCommand()` parser
(`src/checks/shellCommand.ts`) passes the whole adversarial bypass suite, the cases it
can't catch are opaque to any static parser, and tree-sitter-bash is a native dependency
that adds build/install friction to a zero-friction `npx` CLI. Revisit only with a concrete
bypass the regex provably can't handle. (See KNOWN-GAPS, "Why the shell parser is
regex-based, not tree-sitter".)

## F. Reference-only / FLAGGED — never copy code
- **cass** — MIT **+ OpenAI/Anthropic rider**. Knowledge only: where each of ~26
  agents stores sessions and in what format. Do NOT copy its code. Rider quoted
  in `local/LICENSES-RESEARCH.md`.
- **DO-NOT-REUSE (copyleft / unclear / restricted):** vestige / Operator Lite
  (AGPL-3.0), ClaudeCodeTranscriptViewer (GPL-3.0), kkrlstrm/codex-logger
  (AGPL-3.0), mikhailsal/cursor-chronicle (AGPL-3.0), Veverke/ChatWizard
  (MIT + Commons Clause), somogyijanos/cursor-chat-export (no LICENSE, archived),
  ericmjl/opencode-session-viewer (LICENSE unverifiable). Read for ideas only;
  reimplement independently if needed.

## Adapter-source decision (2026-10-02)
- **cli-continues** (yigitkonur/cli-continues) = main adapter source. **MIT**
  (file-verified). Reverse-engineered from **Pilan-AI/mnemo**, also **MIT** —
  clean chain. Reads 16 agents, one parser per file in `src/parsers/`, captures
  shell commands with exit codes, edits, reads, MCP calls, subagents.
- **PORT, don't depend:** copy parser files into our adapter layer one agent at a
  time, pinned to a recorded commit SHA, credit in NOTICE + file header; map to
  our neutral events. Record agent version + pinned SHA per adapter here.
- **Node constraint:** ours is `engines.node >=20`. DECISION: keep `>=20`. JSON/JSONL
  agents (Copilot CLI, Gemini, Cline, Aider, Antigravity, and Cursor's current
  `agent-transcripts`) read on Node 20 directly. SQLite agents (OpenCode, Devin Desktop)
  use the built-in **`node:sqlite`**, which needs Node 22.5+; on older Node the db is
  skipped with a one-line note rather than failing. So `node:sqlite` is used — NOT
  sql.js/WASM (sql.js is not a dependency) — and `>=20` still holds for the rest. (We
  weighed a WASM sqlite to avoid the 22.5 floor and chose the graceful skip: no native/wasm
  bundle, simpler.)
- **Licence results (2026-10-02, gh api):** MIT — cli-continues, mnemo, ai-timeline,
  S2thend/cursor-history, anasabbasdev/cursor-chat-bulk-export,
  markwroberts0/cursor-chat-recovery, junxit/agentic-session-explorer,
  Reality-Shifting-Tech/sessionport, Ickleslimer/codetalker. **NO LICENSE (do not
  use):** kruzovic7/ai-data-extractor (404), agentscrub (404). Never: ChatWizard
  (Commons Clause), monkai-trace.
- Each ported adapter does a **schema fingerprint**: unknown fields/shape ->
  "format newer than tested (last tested: <agent version>)", never a guess.
  "supported" needs real sample + planted + clean fixtures; else "experimental".

## Ported adapters (status)
No third-party code was copied. Each reader is our own code; where another MIT project
documented the format we credit it in NOTICE.md, otherwise we reverse-engineered it from a
real session. "Supported" = validated on a real session with planted + clean fixtures.
- **Codex CLI** — **SUPPORTED** (validated 0.160.1). `src/adapters/codex.ts`; reads
  `rollout-*.jsonl(.zst)`. Our own code, reverse-engineered from a real rollout.
- **Copilot CLI** — **SUPPORTED** (validated 1.0.92). `src/adapters/copilot.ts`, reads
  `events.jsonl`. Our own code, written with reference to cli-continues' format
  documentation (MIT, pinned `e486cd2`; from mnemo MIT), credited in NOTICE.md.
- **Cursor CLI** — **SUPPORTED** (validated v2026.10.01). `src/adapters/cursor.ts`, current
  `agent-transcripts` JSONL, read-only (never opens `state.vscdb`). Our own code, written
  with reference to cli-continues' format documentation (MIT), credited in NOTICE.md.
- **Antigravity (Google)** — **SUPPORTED** (validated 1.3.1). `src/adapters/antigravity.ts`.
  Our own code, reverse-engineered from a real session.
- **OpenCode** — **SUPPORTED** (validated 1.18.35). `src/adapters/opencode.ts`; reads the
  SQLite `opencode.db` via `node:sqlite` (Node 22.5+; skipped with a note on older Node) and
  the legacy 3-dir JSON store. Our own code, written with reference to cli-continues' format
  documentation (MIT), credited in NOTICE.md.
- **Cline** — **SUPPORTED** (validated v3.0.70). `src/adapters/cline.ts`. Our own code,
  reverse-engineered from a real session.
- **Devin Desktop** — **SUPPORTED** (validated 3.10.48). `src/adapters/devin.ts`; reads
  `sessions.db` via `node:sqlite`, walking each session's main chain to dedupe retries. Our
  own code, reverse-engineered from a real session.
- **Gemini CLI** — session reading **not pursued**: the standalone Gemini CLI refuses a
  personal login ("migrate to Antigravity"), so there is no readable session source. The
  reader code exists (written with reference to cli-continues' format documentation, MIT,
  credited in NOTICE.md) but Gemini is **rules-file-only**; use Antigravity for that family.
