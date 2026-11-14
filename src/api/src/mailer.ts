import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";

export interface LoginEmail {
  to: string;
  code: string;
  link: string;
  expiresMinutes: number;
}

export interface DeletionCodeEmail {
  to: string;
  code: string;
  expiresMinutes: number;
}

export interface NotifyConfirmEmail {
  to: string;
  link: string;
  expiresHours: number;
}

export interface ReportReadyEmail {
  to: string;
  target: string;
  tierName: string;
  status: "complete" | "stopped";
  findings: number;
  highOrAbove: number;
  link: string;
}

export interface Mailer {
  sendLoginCode(email: LoginEmail): Promise<void>;
  /** The fresh one-time code that confirms an account deletion. */
  sendDeletionCode(email: DeletionCodeEmail): Promise<void>;
  /** Sent after the data is gone. */
  sendAccountDeleted(email: { to: string }): Promise<void>;
  /** Asks the owner of a notification address to confirm it before any report notice is sent. */
  sendNotifyConfirmation(email: NotifyConfirmEmail): Promise<void>;
  /** Tells a scan's confirmed notification address that a report is ready. */
  sendReportReady(email: ReportReadyEmail): Promise<void>;
  /** An operational alert to staff (the daily spend alarm). */
  sendStaffAlert(email: StaffAlertEmail): Promise<void>;
}

export interface StaffAlertEmail {
  to: string;
  subject: string;
  text: string;
}

interface Rendered {
  subject: string;
  text: string;
  html: string;
}

export function renderReportReadyEmail(email: ReportReadyEmail): Rendered {
  const { target, tierName, findings, highOrAbove, link } = email;
  const counts = `${findings} ${findings === 1 ? "finding" : "findings"}${highOrAbove > 0 ? `, ${highOrAbove} high or above` : ""}`;
  const subject = `Your Swarm report for ${target} is ready (${counts})`;
  const text = [
    `Your ${tierName} scan of ${target} has finished with ${counts}.`,
    "",
    `Sign in to read the report: ${link}`,
    "",
    "This is an automated, AI-assisted assessment and is not a substitute for a manual penetration test.",
  ].join("\n");
  const html = `<p>Your <strong>${tierName}</strong> scan of <strong>${target}</strong> has finished with ${counts}.</p><p><a href="${link}">Sign in to read the report</a>.</p><p style="color:#666">This is an automated, AI-assisted assessment and is not a substitute for a manual penetration test.</p>`;
  return { subject, text, html };
}

export function renderLoginEmail({ code, link, expiresMinutes }: LoginEmail): Rendered {
  const subject = `Your Swarm sign-in code: ${code}`;
  const text = [
    `Your Swarm sign-in code is ${code}.`,
    `It expires in ${expiresMinutes} minutes and can be used once.`,
    "",
    `Or open this link to sign in: ${link}`,
    "",
    "If you did not ask for this, ignore this email. Nobody can sign in without it.",
  ].join("\n");
  const html = `<p>Your Swarm sign-in code is <strong style="font-size:1.4em;letter-spacing:.1em">${code}</strong>.</p><p>It expires in ${expiresMinutes} minutes and can be used once.</p><p><a href="${link}">Or click here to sign in</a>.</p><p style="color:#666">If you did not ask for this, ignore this email. Nobody can sign in without it.</p>`;
  return { subject, text, html };
}

export function renderDeletionCodeEmail({ code, expiresMinutes }: DeletionCodeEmail): Rendered {
  const subject = `Confirm deleting your Swarm account: ${code}`;
  const text = [
    `Your code to delete your Swarm account is ${code}.`,
    `It expires in ${expiresMinutes} minutes and can be used once.`,
    "",
    "Deleting your account removes every saved target, scan, run, report and credential, and cannot be undone.",
    "If you did not ask for this, ignore this email and nothing will be deleted.",
  ].join("\n");
  const html = `<p>Your code to delete your Swarm account is <strong style="font-size:1.4em;letter-spacing:.1em">${code}</strong>.</p><p>It expires in ${expiresMinutes} minutes and can be used once.</p><p>Deleting your account removes every saved target, scan, run, report and credential, and cannot be undone.</p><p style="color:#666">If you did not ask for this, ignore this email and nothing will be deleted.</p>`;
  return { subject, text, html };
}

export function renderAccountDeletedEmail(): Rendered {
  const subject = "Your Swarm account has been deleted";
  const text = [
    "Your Swarm account and everything saved in it (targets, scans, runs, reports, credentials) has been deleted.",
    "Anonymised cost figures are kept, as described in our privacy notice.",
    "",
    "If you did not do this, reply to this email.",
  ].join("\n");
  const html =
    '<p>Your Swarm account and everything saved in it (targets, scans, runs, reports, credentials) has been deleted.</p><p>Anonymised cost figures are kept, as described in our privacy notice.</p><p style="color:#666">If you did not do this, reply to this email.</p>';
  return { subject, text, html };
}

export function renderNotifyConfirmEmail({ link, expiresHours }: NotifyConfirmEmail): Rendered {
  const subject = "Confirm your address for Swarm security scan notices";
  const text = [
    "A Swarm user asked us to send security scan notices to this address.",
    `Open this link within ${expiresHours} hours to confirm it: ${link}`,
    "",
    "Until you confirm, nothing else will be sent. If this is not for you, ignore this email.",
  ].join("\n");
  const html = `<p>A Swarm user asked us to send security scan notices to this address.</p><p><a href="${link}">Confirm this address</a> within ${expiresHours} hours.</p><p style="color:#666">Until you confirm, nothing else will be sent. If this is not for you, ignore this email.</p>`;
  return { subject, text, html };
}

export class SesMailer implements Mailer {
  constructor(
    private readonly options: { from: string; replyTo: string; configurationSet: string },
    private readonly client = new SESv2Client({}),
  ) {}

  private async send(to: string, { subject, text, html }: Rendered): Promise<void> {
    await this.client.send(
      new SendEmailCommand({
        FromEmailAddress: this.options.from,
        ReplyToAddresses: [this.options.replyTo],
        ConfigurationSetName: this.options.configurationSet,
        Destination: { ToAddresses: [to] },
        Content: {
          Simple: {
            Subject: { Data: subject, Charset: "UTF-8" },
            Body: {
              Text: { Data: text, Charset: "UTF-8" },
              Html: { Data: html, Charset: "UTF-8" },
            },
          },
        },
      }),
    );
  }

  sendLoginCode(email: LoginEmail) {
    return this.send(email.to, renderLoginEmail(email));
  }
  sendDeletionCode(email: DeletionCodeEmail) {
    return this.send(email.to, renderDeletionCodeEmail(email));
  }
  sendAccountDeleted(email: { to: string }) {
    return this.send(email.to, renderAccountDeletedEmail());
  }
  sendNotifyConfirmation(email: NotifyConfirmEmail) {
    return this.send(email.to, renderNotifyConfirmEmail(email));
  }
  sendReportReady(email: ReportReadyEmail) {
    return this.send(email.to, renderReportReadyEmail(email));
  }
  sendStaffAlert({ to, subject, text }: StaffAlertEmail) {
    const html = `<p>${text.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</p>`;
    return this.send(to, { subject, text, html });
  }
}

/** Collects mail in memory instead of sending it (unit tests and the local dev server). */
export class FakeMailer implements Mailer {
  readonly sent: LoginEmail[] = [];
  readonly deletionCodes: DeletionCodeEmail[] = [];
  readonly deleted: string[] = [];
  readonly confirmations: NotifyConfirmEmail[] = [];
  readonly reports: ReportReadyEmail[] = [];
  readonly alerts: StaffAlertEmail[] = [];

  async sendReportReady(email: ReportReadyEmail): Promise<void> {
    this.reports.push(email);
  }
  async sendStaffAlert(email: StaffAlertEmail): Promise<void> {
    this.alerts.push(email);
  }

  async sendLoginCode(email: LoginEmail): Promise<void> {
    this.sent.push(email);
  }
  async sendDeletionCode(email: DeletionCodeEmail): Promise<void> {
    this.deletionCodes.push(email);
  }
  async sendAccountDeleted(email: { to: string }): Promise<void> {
    this.deleted.push(email.to);
  }
  async sendNotifyConfirmation(email: NotifyConfirmEmail): Promise<void> {
    this.confirmations.push(email);
  }

  lastTo(address: string): LoginEmail | undefined {
    return [...this.sent].reverse().find((m) => m.to === address);
  }
  lastDeletionCodeTo(address: string): DeletionCodeEmail | undefined {
    return [...this.deletionCodes].reverse().find((m) => m.to === address);
  }
  lastConfirmationTo(address: string): NotifyConfirmEmail | undefined {
    return [...this.confirmations].reverse().find((m) => m.to === address);
  }
}
