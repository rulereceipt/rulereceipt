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

## Status as of 2026-10-02
**Nothing third-party has been ported yet.** All shipped code is our own. The
only "reuse" so far is our own forks (agnix, rulesync, deja-vu) created earlier,
untouched. This file is the plan for the adapter + health-check work; each entry
flips to "ported" with a NOTICE line when it actually lands.

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

## E. tree-sitter-bash (MIT) — shell parsing (evaluate only)
Evaluate for parsing shell commands properly (`git -C dir push`, commands inside
`bash -c`) **only if** it keeps the package small and fast. Today we use our own
`segments()`/`leadingCommand()` heuristic (`src/checks/shellCommand.js`). Adopt
only if the size/speed budget holds.

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
- **Node constraint:** ours is `engines.node >=20`; cli-continues needs `>=22.5`
  only because it uses `node:sqlite`. DECISION: keep `>=20`. JSON/JSONL agents
  (Copilot CLI, Gemini, Cline/Roo/Kilo, Aider, Antigravity, Kimi, Qwen, Droid,
  Amp, Kiro) port to Node 20 directly. SQLite agents (OpenCode, Crush, old Cursor)
  use a WASM sqlite (sql.js, as ai-timeline does) instead of `node:sqlite`, so we
  do not force a Node bump. Cursor newer `agent-transcripts` are JSONL (no SQLite).
- **Licence results (2026-10-02, gh api):** MIT — cli-continues, mnemo, ai-timeline,
  S2thend/cursor-history, anasabbasdev/cursor-chat-bulk-export,
  markwroberts0/cursor-chat-recovery, junxit/agentic-session-explorer,
  Reality-Shifting-Tech/sessionport, Ickleslimer/codetalker. **NO LICENSE (do not
  use):** kruzovic7/ai-data-extractor (404), agentscrub (404). Never: ChatWizard
  (Commons Clause), monkai-trace.
- Each ported adapter does a **schema fingerprint**: unknown fields/shape ->
  "format newer than tested (last tested: <agent version>)", never a guess.
  "supported" needs real sample + planted + clean fixtures; else "experimental".
