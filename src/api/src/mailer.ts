import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";

export interface LoginEmail {
  to: string;
  code: string;
  link: string;
  expiresMinutes: number;
}

export interface Mailer {
  sendLoginCode(email: LoginEmail): Promise<void>;
}

export function renderLoginEmail({ code, link, expiresMinutes }: LoginEmail) {
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

export class SesMailer implements Mailer {
  constructor(
    private readonly options: { from: string; replyTo: string; configurationSet: string },
    private readonly client = new SESv2Client({}),
  ) {}

  async sendLoginCode(email: LoginEmail): Promise<void> {
    const { subject, text, html } = renderLoginEmail(email);
    await this.client.send(
      new SendEmailCommand({
        FromEmailAddress: this.options.from,
        ReplyToAddresses: [this.options.replyTo],
        ConfigurationSetName: this.options.configurationSet,
        Destination: { ToAddresses: [email.to] },
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
}

/** Collects mail in memory instead of sending it (unit tests and the local dev server). */
export class FakeMailer implements Mailer {
  readonly sent: LoginEmail[] = [];
  async sendLoginCode(email: LoginEmail): Promise<void> {
    this.sent.push(email);
  }
  lastTo(address: string): LoginEmail | undefined {
    return [...this.sent].reverse().find((m) => m.to === address);
  }
}
