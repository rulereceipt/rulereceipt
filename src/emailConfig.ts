import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface EmailConfig {
  managerEmail: string;
  senderEmail: string;
  senderAppPassword: string;
}

function configDir(): string {
  return join(homedir(), ".rulereceipt");
}

function configPath(): string {
  return join(configDir(), "config.json");
}

/**
 * Local-only credential store — never sent to any RuleReceipt server,
 * used exclusively to authenticate the user's own SMTP send. Restricted
 * to owner-read/write only (0600), same convention as .netrc/.npmrc.
 */
export function saveEmailConfig(config: EmailConfig): void {
  const dir = configDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const path = configPath();
  writeFileSync(path, JSON.stringify(config, null, 2), "utf-8");
  chmodSync(path, 0o600);
}

export function loadEmailConfig(): EmailConfig | null {
  try {
    const raw = readFileSync(configPath(), "utf-8");
    const parsed = JSON.parse(raw) as Partial<EmailConfig>;
    if (
      typeof parsed.managerEmail === "string" &&
      typeof parsed.senderEmail === "string" &&
      typeof parsed.senderAppPassword === "string"
    ) {
      return parsed as EmailConfig;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * SMTP host auto-detected from the sender's email domain — covers the
 * common providers without asking a dev to know their own SMTP
 * settings. Falls back to null (caller must ask for an explicit host)
 * for anything else, rather than guessing wrong silently.
 */
export function detectSmtpHost(senderEmail: string): { host: string; port: number } | null {
  const domain = senderEmail.split("@")[1]?.toLowerCase();
  const known: Record<string, { host: string; port: number }> = {
    "gmail.com": { host: "smtp.gmail.com", port: 465 },
    "outlook.com": { host: "smtp.office365.com", port: 587 },
    "hotmail.com": { host: "smtp.office365.com", port: 587 },
    "live.com": { host: "smtp.office365.com", port: 587 },
  };
  return domain && known[domain] ? known[domain] : null;
}
