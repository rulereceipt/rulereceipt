#!/usr/bin/env node
import { Command } from "commander";
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { parseClaudeMd } from "./parsers/claudeMdParser.js";
import { readLatestTranscript, findLatestSessionFile } from "./parsers/transcriptParser.js";
import { classifyRules } from "./checks/classify.js";
import { runDeterministicChecks } from "./checks/deterministicChecks.js";
import { runJudgmentChecks } from "./checks/judgmentChecks.js";
import { generateReport, generateMarkdownReport } from "./report/generateReport.js";
import type { Rule, CheckResult } from "./types.js";

const DEMO_RESULTS: CheckResult[] = [
  { ruleId: "7", ruleTitle: "Tests must be able to fail", status: "PASS", evidence: "sabotage-and-revert shown before the green run" },
  { ruleId: "4", ruleTitle: "Surface bad news first", status: "FAIL", evidence: "reply led with passing tests, the one broken test was mentioned last" },
  { ruleId: "11", ruleTitle: "Fails closed on error", status: "UNCLEAR", evidence: "no error occurred this session, nothing to verify against" },
];

function loadRules(cwd: string): Rule[] {
  const globalPath = join(homedir(), ".claude", "CLAUDE.md");
  const rules: Rule[] = [...parseClaudeMd(globalPath, "global")];

  for (const name of ["CLAUDE.md", "AGENTS.md"]) {
    const projectPath = join(cwd, name);
    if (existsSync(projectPath)) {
      rules.push(...parseClaudeMd(projectPath, "project"));
    }
  }
  return rules;
}

async function runCheck(markdown: boolean) {
  const cwd = process.cwd();
  const rules = loadRules(cwd);

  if (rules.length === 0) {
    console.log(
      "No CLAUDE.md or AGENTS.md found — checked this project directory and ~/.claude/CLAUDE.md.\n" +
        "Nothing to check yet. Add rules to one of those files, then run this again."
    );
    return;
  }

  const sessionFilePath = findLatestSessionFile(cwd);
  if (!sessionFilePath) {
    console.log(
      "No Claude Code session found for this project yet.\n" +
        "Run Claude Code here at least once, then try `rulereceipt check` again."
    );
    return;
  }

  const events = readLatestTranscript(cwd);
  const classifications = classifyRules(rules);
  const deterministic = classifications.filter((c) => c.kind === "deterministic");
  const judgment = classifications.filter((c) => c.kind === "judgment");

  const deterministicResults = runDeterministicChecks(deterministic, events);
  const judgmentResults = await runJudgmentChecks(judgment, events);
  const results = [...deterministicResults, ...judgmentResults];

  const meta = { sessionFilePath, ruleCount: rules.length };
  console.log(markdown ? generateMarkdownReport(results, meta) : generateReport(results, meta));
}

function runDemo(markdown: boolean) {
  const meta = { sessionFilePath: null, ruleCount: DEMO_RESULTS.length };
  console.log("(demo — no setup needed, this is sample output, not a real check)\n");
  console.log(markdown ? generateMarkdownReport(DEMO_RESULTS, meta) : generateReport(DEMO_RESULTS, meta));
}

const program = new Command();
program.name("rulereceipt").description("See exactly what your AI agent actually did.");

program
  .command("check", { isDefault: true })
  .description("Check the current project's latest Claude Code session against CLAUDE.md/AGENTS.md")
  .option("--markdown", "output as markdown, for pasting into a PR or Slack")
  .action((opts) => {
    runCheck(Boolean(opts.markdown)).catch((err) => {
      console.error("Something went wrong:", err instanceof Error ? err.message : err);
      process.exitCode = 1;
    });
  });

program
  .command("demo")
  .description("See a sample report — no setup, no API key needed")
  .option("--markdown", "output as markdown")
  .action((opts) => {
    runDemo(Boolean(opts.markdown));
  });

program.parse();
