/** What the explorer sees of a page. It is built from the rendered page and holds no form values. */
export interface PageLink {
  id: number;
  text: string;
  href: string;
}

export interface PageForm {
  action: string;
  method: string;
  fields: { name: string; type: string; label: string }[];
}

export interface PageSnapshot {
  /** The URL after redirects. */
  url: string;
  status: number;
  title: string;
  /** Visible text, truncated. */
  text: string;
  links: PageLink[];
  forms: PageForm[];
  /** External script URLs (absolute). */
  scripts: string[];
  /** The start of each inline script, for endpoint discovery. */
  inlineScripts: string[];
  hasPasswordField: boolean;
}

export interface BrowserCookie {
  name: string;
  /** The cookie's value. A secret: it is kept in memory for the role-aware checks and never logged or emitted. */
  value: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: string | null;
}

export interface SignInResult {
  ok: boolean;
  /** What happened, for the model and the log. Never contains the password. */
  message: string;
  landedUrl: string;
  /** True when the credentials were sent over plain HTTP. */
  insecureTransport: boolean;
  snapshot: PageSnapshot | null;
}

export interface BlockedRequest {
  method: string;
  url: string;
  reason: string;
}

/** A browser session on the target. Everything it requests goes through the scope proxy. */
export interface PageDriver {
  open(url: string): Promise<PageSnapshot>;
  /** Fills the sign-in form on the current page and submits it; the only state-changing request allowed. */
  signIn(login: { username: string; password: string }): Promise<SignInResult>;
  cookies(): Promise<BrowserCookie[]>;
  /** Forgets every cookie, so the next sign-in starts from a signed-out browser. */
  resetSession(): Promise<void>;
  /** Requests the browser sent (through the proxy). */
  readonly requests: number;
  /** Requests the browser refused to send, and why (not seen by the proxy). */
  readonly blocked: BlockedRequest[];
  close(): Promise<void>;
}

export interface DriverOptions {
  proxy: { host: string; port: number; loginKey?: string };
  /** Hostnames the browser may request; everything else is refused before it leaves. */
  hosts: readonly string[];
  /** Sign-in submissions the browser may make. */
  loginSubmissions: number;
  userAgent: string;
}

export type DriverFactory = (options: DriverOptions) => Promise<PageDriver>;
