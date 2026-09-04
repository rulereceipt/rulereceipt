import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface HookEntry {
  sourceFile: string;
  event: string;
  command: string;
  flags: string[];
  /**
   * The matcher the hook is registered under — which tool it fires on, for
   * tool-call events. Kept because it is the only machine-readable statement
   * of what a hook watches; the command itself is usually a script path whose
   * contents this tool does not read.
   */
  matcher?: string;
}

export interface DoctorResult {
  filesScanned: string[];
  filesFound: string[];
  hooks: HookEntry[];
  newSinceLastRun: HookEntry[];
}

// Deliberately narrow and literal — false positives waste trust, false
// negatives are the actual risk being managed, so this errs toward
// flagging anything that could plausibly fetch/exec/obfuscate, not toward
// being clever about it.
const SUSPICIOUS_PATTERNS = ["curl", "wget", "base64", "node -e", "eval "];

function flagCommand(command: string): string[] {
  const flags: string[] = [];
  for (const pattern of SUSPICIOUS_PATTERNS) {
    if (command.includes(pattern)) flags.push(`contains "${pattern}"`);
  }
  if (!command.startsWith("/") && !command.match(/^[a-zA-Z]:\\/)) {
    flags.push("non-absolute binary path (PATH-hijackable)");
  }
  return flags;
}

function extractHooksFromSettings(filePath: string): HookEntry[] {
  if (!existsSync(filePath)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return [];
  }
  const hooks = (parsed as { hooks?: Record<string, unknown> })?.hooks;
  if (!hooks || typeof hooks !== "object") return [];

  const entries: HookEntry[] = [];
  for (const [event, matchers] of Object.entries(hooks)) {
    if (!Array.isArray(matchers)) continue;
    for (const matcher of matchers) {
      const hookList = (matcher as { hooks?: unknown[] })?.hooks;
      if (!Array.isArray(hookList)) continue;
      const matcherName = (matcher as { matcher?: unknown })?.matcher;
      for (const h of hookList) {
        const command = (h as { command?: unknown })?.command;
        if (typeof command === "string") {
          entries.push({
            sourceFile: filePath,
            event,
            command,
            flags: flagCommand(command),
            matcher: typeof matcherName === "string" ? matcherName : undefined,
          });
        }
      }
    }
  }
  return entries;
}

// VS Code tasks.json shape per public docs (runOptions.runOn: "folderOpen")
// — not verified against a real example file on this machine, since none
// exists here. Documented shape only; report this honestly if it ever
// misses a real-world variant.
function extractFolderOpenTasks(filePath: string): HookEntry[] {
  if (!existsSync(filePath)) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf-8"));
  } catch {
    return [];
  }
  const tasks = (parsed as { tasks?: unknown[] })?.tasks;
  if (!Array.isArray(tasks)) return [];

  const entries: HookEntry[] = [];
  for (const task of tasks) {
    const runOn = (task as { runOptions?: { runOn?: unknown } })?.runOptions?.runOn;
    const command = (task as { command?: unknown })?.command;
    if (runOn === "folderOpen" && typeof command === "string") {
      entries.push({ sourceFile: filePath, event: "folderOpen (VS Code task)", command, flags: flagCommand(command) });
    }
  }
  return entries;
}

// Scoped per-project, not one global file — otherwise running `doctor` in
// two different projects would mix their hooks together and "new since
// last run" would be meaningless. Same encoding convention already used
// for Claude Code's own project directories elsewhere in this codebase.
function snapshotPath(cwd: string): string {
  const encoded = cwd.replace(/\//g, "-");
  return join(homedir(), ".rulereceipt", "doctor-snapshots", `${encoded}.json`);
}

function loadSnapshot(cwd: string): HookEntry[] {
  try {
    return JSON.parse(readFileSync(snapshotPath(cwd), "utf-8"));
  } catch {
    return [];
  }
}

function saveSnapshot(cwd: string, hooks: HookEntry[]): void {
  const dir = join(homedir(), ".rulereceipt", "doctor-snapshots");
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(snapshotPath(cwd), JSON.stringify(hooks, null, 2));
  } catch {
    // best-effort only — doctor still works without persisting a snapshot,
    // it just can't report "new since last run" next time
  }
}

/**
 * Lists every Claude Code hook and VS Code folderOpen task this machine
 * or this project would run automatically, and flags anything suspicious
 * (fetches, obfuscation, non-absolute binaries). Zero rubric, zero API
 * key — pure local file reading. Answers "what's in my config that I
 * didn't put there," the exact gap behind hook-persistence supply-chain
 * attacks (uninstalling the malicious package does not remove the hook
 * it already wrote).
 */
export function runDoctor(cwd: string): DoctorResult {
  const candidateFiles = [
    join(homedir(), ".claude", "settings.json"),
    join(cwd, ".claude", "settings.json"),
    join(cwd, ".claude", "settings.local.json"),
    join(cwd, ".vscode", "tasks.json"),
  ];

  const filesScanned = candidateFiles;
  const filesFound = candidateFiles.filter((f) => existsSync(f));

  const hooks: HookEntry[] = [];
  for (const file of candidateFiles) {
    if (file.endsWith("tasks.json")) {
      hooks.push(...extractFolderOpenTasks(file));
    } else {
      hooks.push(...extractHooksFromSettings(file));
    }
  }

  const previous = loadSnapshot(cwd);
  const previousKeys = new Set(previous.map((h) => `${h.sourceFile}|${h.event}|${h.command}`));
  const newSinceLastRun = hooks.filter((h) => !previousKeys.has(`${h.sourceFile}|${h.event}|${h.command}`));

  saveSnapshot(cwd, hooks);

  return { filesScanned, filesFound, hooks, newSinceLastRun };
}
