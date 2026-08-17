import nodemailer from "nodemailer";
import { detectSmtpHost, type EmailConfig } from "./emailConfig.js";

export interface SendResult {
  sent: boolean;
  error?: string;
}

/**
 * Sends directly from the dev's own email account via their own SMTP
 * credentials — no RuleReceipt server is ever in this path. A send
 * failure (bad password, unknown provider, network) must never crash
 * the whole `check` command; the report was already printed locally
 * before this runs, so failure here only means the email step failed,
 * not the check itself.
 */
export async function sendReportEmail(config: EmailConfig, reportText: string): Promise<SendResult> {
  const smtp = detectSmtpHost(config.senderEmail);
  if (!smtp) {
    return {
      sent: false,
      error: `Don't recognize the email provider for ${config.senderEmail} — currently supports Gmail and Outlook/Hotmail/Live only.`,
    };
  }

  try {
    const transporter = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.port === 465,
      auth: { user: config.senderEmail, pass: config.senderAppPassword },
    });

    await transporter.sendMail({
      from: config.senderEmail,
      to: config.managerEmail,
      subject: "RuleReceipt — session report",
      text: reportText,
    });

    return { sent: true };
  } catch (err) {
    return { sent: false, error: err instanceof Error ? err.message : String(err) };
  }
}
