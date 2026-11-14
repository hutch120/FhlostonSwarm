import { createApp, type AppDeps } from "./app.js";
import { authConfig, type AuthConfig } from "./config.js";
import { FakeLauncher } from "./launcher.js";
import { acquireRun } from "./pool.js";
import { FakeMailer, type Mailer } from "./mailer.js";
import { MemoryPublisher } from "./publisher.js";
import type { Secrets } from "./sessions.js";
import { MemoryStore } from "./storage/memory.js";
import type { ObjectStore } from "./storage/store.js";

export const SITE = "https://fhlostonswarm.com";

const down = async (): Promise<never> => {
  throw new Error("ses down");
};

/** A mailer whose every send fails, to prove requests still succeed when SES is down. */
export const failingMailer: Mailer = {
  sendLoginCode: down,
  sendDeletionCode: down,
  sendAccountDeleted: down,
  sendNotifyConfirmation: down,
  sendReportReady: down,
  sendStaffAlert: down,
};

export const testSecrets: Secrets = {
  pepper: "test-pepper-not-a-secret",
  jwtKey: new TextEncoder().encode("test-jwt-key-not-a-secret-0123456789"),
};

export const testConfig = (overrides: Partial<AuthConfig> = {}): AuthConfig => ({
  ...authConfig,
  minRequestMs: 0,
  ...overrides,
});

/** A controllable clock for expiry tests. */
export function createClock(start = Date.UTC(2026, 0, 1)) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

interface Cookie {
  value: string;
  path: string;
}

/** A tiny browser: keeps cookies (honouring Path and clearing) and sends same-origin headers. */
export class TestBrowser {
  private jar = new Map<string, Cookie>();
  csrf: string | undefined;

  constructor(
    private readonly app: ReturnType<typeof createApp>,
    private readonly ip = "203.0.113.7",
  ) {}

  cookie(name: string): string | undefined {
    return this.jar.get(name)?.value;
  }

  names(): string[] {
    return [...this.jar.keys()];
  }

  async request(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    const url = new URL(path, SITE);
    const sent = [...this.jar.entries()]
      .filter(([, c]) => url.pathname.startsWith(c.path))
      .map(([name, c]) => `${name}=${c.value}`)
      .join("; ");
    const init: RequestInit = {
      method,
      headers: {
        ...(sent ? { cookie: sent } : {}),
        "cloudfront-viewer-address": `${this.ip}:4242`,
        ...(method !== "GET" ? { origin: SITE, "content-type": "application/json" } : {}),
        ...headers,
      },
      body: body === undefined ? (method === "GET" ? undefined : "{}") : JSON.stringify(body),
    };
    const res = await this.app.request(url.pathname + url.search, init);
    for (const line of res.headers.getSetCookie()) this.store(line);
    return res;
  }

  /** A mutating call carrying the per-session CSRF token, as the web client does. */
  withCsrf(method: string, path: string, body?: unknown) {
    return this.request(method, path, body, this.csrf ? { "x-csrf-token": this.csrf } : {});
  }

  private store(line: string) {
    const [pair, ...attrs] = line.split(";").map((s) => s.trim());
    const eq = pair!.indexOf("=");
    const name = pair!.slice(0, eq);
    const value = pair!.slice(eq + 1);
    const attr = (key: string) =>
      attrs.find((a) => a.toLowerCase().startsWith(`${key}=`))?.slice(key.length + 1);
    if (attr("max-age") === "0" || value === "") this.jar.delete(name);
    else this.jar.set(name, { value, path: attr("path") ?? "/" });
  }
}

export interface Harness {
  app: ReturnType<typeof createApp>;
  store: ObjectStore;
  mailer: FakeMailer;
  launcher: FakeLauncher;
  publisher: MemoryPublisher;
  clock: ReturnType<typeof createClock>;
  browser: (ip?: string) => TestBrowser;
  /** Request a code for `email` and return it from the fake mailbox. */
  codeFor: (browser: TestBrowser, email: string) => Promise<string>;
  signIn: (browser: TestBrowser, email: string) => Promise<Response>;
}

export function createHarness(overrides: Partial<AppDeps> = {}): Harness {
  const store = overrides.store ?? new MemoryStore();
  const mailer = new FakeMailer();
  const launcher = new FakeLauncher();
  // The real execution's first step takes a slot in the depth pool and starts the run.
  launcher.onStart = async (owner, runId) => {
    await acquireRun(store, { emailHash: owner, runId }, clock.now());
  };
  const publisher = new MemoryPublisher();
  const clock = createClock();
  const app = createApp({
    store,
    secrets: async () => testSecrets,
    mailer,
    config: testConfig(),
    siteOrigin: SITE,
    cookieSecure: true,
    now: clock.now,
    launcher,
    publisher,
    presign: async (key, { filename }) => `https://data.test/${key}?download=${filename}`,
    stream: { realtimeDomain: "rt.test", httpDomain: "http.test" },
    ...overrides,
  });
  const codeFor = async (browser: TestBrowser, email: string) => {
    const res = await browser.request("POST", "/api/auth/request", { email });
    if (res.status !== 200) throw new Error(`request failed: ${res.status}`);
    const mail = mailer.lastTo(email.trim().toLowerCase());
    if (!mail) throw new Error("no mail was sent");
    return mail.code;
  };
  return {
    app,
    store,
    mailer,
    launcher,
    publisher,
    clock,
    browser: (ip) => new TestBrowser(app, ip),
    codeFor,
    signIn: async (browser, email) => {
      const code = await codeFor(browser, email);
      const res = await browser.request("POST", "/api/auth/verify", { email, code });
      if (res.status === 200)
        browser.csrf = ((await res.clone().json()) as { csrfToken: string }).csrfToken;
      return res;
    },
  };
}
