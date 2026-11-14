import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Response,
} from "playwright-core";
import { isSafeMethod, normaliseHost } from "../policy.js";
import { LOGIN_HEADER } from "../proxy.js";
import type {
  BlockedRequest,
  BrowserCookie,
  DriverOptions,
  PageDriver,
  PageSnapshot,
  SignInResult,
} from "./driver.js";

const NAVIGATION_TIMEOUT_MS = 15_000;
const MAX_TEXT = 6000;
const MAX_LINKS = 80;
const MAX_BLOCKED_KEPT = 200;
/** The field a login's secret goes in: a password, or a one-time code / test passcode box. */
const SECRET_FIELD_BASE = "input[type=password], input[autocomplete=one-time-code]";
const SECRET_FIELD = "input[type=password]:visible, input[autocomplete=one-time-code]:visible";

/** Runs in the page: what the explorer is allowed to see. Form values are never read. */
const EXTRACT = `(() => {
  const clip = (s, n) => (s || "").replace(/\\s+/g, " ").trim().slice(0, n);
  const links = [];
  const seen = new Set();
  for (const a of document.querySelectorAll("a[href]")) {
    const href = a.href;
    if (!/^https?:/i.test(href) || seen.has(href)) continue;
    seen.add(href);
    links.push({ text: clip(a.textContent, 80), href });
    if (links.length >= ${MAX_LINKS}) break;
  }
  const forms = [...document.forms].slice(0, 10).map((f) => ({
    action: f.action || location.href,
    method: (f.method || "get").toLowerCase(),
    fields: [...f.elements]
      .filter((e) => e.name && e.type !== "hidden")
      .slice(0, 20)
      .map((e) => ({
        name: e.name,
        type: e.type || "text",
        label: clip((e.labels && e.labels[0] && e.labels[0].textContent) || e.placeholder || "", 60),
      })),
  }));
  return {
    title: clip(document.title, 200),
    text: (document.body ? document.body.innerText : "").replace(/[ \\t]+/g, " ").replace(/\\n{3,}/g, "\\n\\n").trim().slice(0, ${MAX_TEXT}),
    links,
    forms,
    scripts: [...document.scripts].map((s) => s.src).filter(Boolean),
    inlineScripts: [...document.scripts].filter((s) => !s.src).map((s) => clip(s.textContent, 4000)).slice(0, 5),
    hasPasswordField: !!document.querySelector(${JSON.stringify(SECRET_FIELD_BASE)}),
  };
})()`;

/**
 * A Chromium session that can only reach the scope proxy. The browser is forced through the proxy
 * (loopback included), cannot resolve names itself, and refuses every request outside the declared
 * hosts. Only safe methods leave it, apart from the sign-in submission while one is in progress:
 * plain-HTTP writes go on to the proxy (which refuses and logs them unless they carry the sign-in
 * key), and HTTPS writes, which the proxy cannot inspect, are refused here.
 */
export class PlaywrightDriver implements PageDriver {
  requests = 0;
  readonly blocked: BlockedRequest[] = [];
  private loginWindow = false;
  private posts = 0;

  private constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    private readonly page: Page,
    private readonly options: DriverOptions,
  ) {}

  static async launch(
    options: DriverOptions,
    executablePath = process.env["SWARM_CHROMIUM_PATH"],
  ): Promise<PlaywrightDriver> {
    const { host, port } = options.proxy;
    const browser = await chromium.launch({
      executablePath,
      args: [
        // The container is the sandbox: it has no namespaces for Chromium's own.
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-sync",
        "--disable-default-apps",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-client-side-phishing-detection",
        "--disable-features=Translate,OptimizationHints,AutofillServerCommunication,MediaRouter,GaiaSignin",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
        `--proxy-server=http://${host}:${port}`,
        "--proxy-bypass-list=<-loopback>",
        // Names are resolved by the proxy, never by the browser.
        "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
      ],
    });
    const context = await browser.newContext({
      userAgent: options.userAgent,
      ignoreHTTPSErrors: true,
      serviceWorkers: "block",
    });
    context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
    const driver = new PlaywrightDriver(browser, context, await context.newPage(), options);
    await context.route("**/*", (route) => driver.guard(route));
    return driver;
  }

  private note(method: string, url: string, reason: string): void {
    if (this.blocked.length < MAX_BLOCKED_KEPT) {
      this.blocked.push({ method, url: url.split("?")[0] ?? url, reason });
    }
  }

  private async guard(route: Parameters<Parameters<BrowserContext["route"]>[1]>[0]) {
    const request = route.request();
    const method = request.method().toUpperCase();
    let url: URL;
    try {
      url = new URL(request.url());
    } catch {
      return route.abort("blockedbyclient");
    }
    const host = normaliseHost(url.hostname);
    if (!this.options.hosts.some((h) => normaliseHost(h) === host)) {
      this.note(method, request.url(), "out_of_scope");
      return route.abort("blockedbyclient");
    }
    if (isSafeMethod(method)) {
      this.requests += 1;
      return route.continue();
    }
    const allowed =
      this.loginWindow && method === "POST" && this.posts < this.options.loginSubmissions;
    if (allowed) {
      this.posts += 1;
      this.requests += 1;
      return route.continue({
        headers: { ...request.headers(), [LOGIN_HEADER]: this.options.proxy.loginKey ?? "" },
      });
    }
    this.note(method, request.url(), "method_not_allowed");
    if (url.protocol === "http:") {
      // The proxy sees plain HTTP: let it refuse the request, so its log shows the block.
      this.requests += 1;
      return route.continue();
    }
    return route.abort("blockedbyclient");
  }

  private async snapshot(status: number): Promise<PageSnapshot> {
    const data = (await this.page.evaluate(EXTRACT)) as Omit<
      PageSnapshot,
      "url" | "status" | "links"
    > & {
      links: { text: string; href: string }[];
    };
    return {
      ...data,
      url: this.page.url(),
      status,
      links: data.links.map((l, i) => ({ id: i + 1, ...l })),
    };
  }

  async open(url: string): Promise<PageSnapshot> {
    const response = await this.page.goto(url, { waitUntil: "domcontentloaded" });
    await this.page.waitForLoadState("load", { timeout: 5000 }).catch(() => undefined);
    await this.page.waitForLoadState("networkidle", { timeout: 2500 }).catch(() => undefined);
    return this.snapshot(response?.status() ?? 0);
  }

  async signIn(login: { username: string; password: string }): Promise<SignInResult> {
    const { page } = this;
    const fail = (message: string, snapshot: PageSnapshot | null = null): SignInResult => ({
      ok: false,
      message,
      landedUrl: page.url(),
      insecureTransport: false,
      snapshot,
    });
    const password = page.locator(SECRET_FIELD).first();
    if ((await password.count()) === 0) {
      return fail(
        "No password or passcode field is visible on this page. It may not be the sign-in page, or the application may sign in some other way (an emailed link or single sign-on).",
      );
    }
    const form = password.locator("xpath=ancestor::form[1]");
    const scope = (await form.count()) > 0 ? form : page.locator("body");
    const user = scope
      .locator(
        "input[type=email]:visible, input[type=text]:visible, input:not([type]):visible:not([autocomplete=one-time-code])",
      )
      .first();
    if ((await user.count()) === 0) return fail("The sign-in form has no username field.");

    const action =
      (await form.count()) > 0
        ? await form.evaluate((f) => (f as HTMLFormElement).action)
        : page.url();
    const insecureTransport = new URL(action || page.url()).protocol === "http:";

    await user.fill(login.username);
    await password.fill(login.password);
    const before = page.url();
    // A refused submission is the application saying the login is wrong, not a form the agent missed.
    const refused: number[] = [];
    const onResponse = (response: Response) => {
      if (response.request().method() === "POST" && response.status() >= 400) {
        refused.push(response.status());
      }
    };
    page.on("response", onResponse);
    this.loginWindow = true;
    try {
      const submit = scope
        .locator("button[type=submit], input[type=submit], button:not([type])")
        .first();
      if ((await submit.count()) > 0) await submit.click({ timeout: 5000 });
      else await password.press("Enter");
      for (let waited = 0; waited < 8000; waited += 250) {
        await page.waitForTimeout(250);
        try {
          if (page.url() !== before || (await page.locator(SECRET_FIELD).count()) === 0) break;
        } catch {
          // The page is navigating; look again on the next pass.
        }
      }
      await page.waitForLoadState("load", { timeout: 5000 }).catch(() => undefined);
      await page.waitForLoadState("networkidle", { timeout: 2500 }).catch(() => undefined);
    } finally {
      this.loginWindow = false;
      page.off("response", onResponse);
    }
    const snapshot = await this.snapshot(200).catch(() => null);
    const stillThere = snapshot?.hasPasswordField ?? false;
    const message = stillThere
      ? refused.length > 0
        ? `The application refused the supplied login (it answered ${refused.at(-1)}), so the username and password or passcode saved for it are wrong or have expired.`
        : page.url() === before
          ? "The sign-in form is still showing, so the sign-in did not succeed."
          : "The page after the sign-in still shows a password field."
      : "Signed in.";
    return {
      ok: !stillThere,
      message,
      landedUrl: page.url(),
      insecureTransport,
      snapshot,
    };
  }

  async cookies(): Promise<BrowserCookie[]> {
    return (await this.context.cookies()).map((c) => ({
      name: c.name,
      value: c.value,
      secure: c.secure,
      httpOnly: c.httpOnly,
      sameSite: c.sameSite ?? null,
    }));
  }

  async resetSession(): Promise<void> {
    await this.context.clearCookies();
  }

  async close(): Promise<void> {
    await this.browser.close().catch(() => undefined);
  }
}

/** True when a Chromium this process can launch exists (tests that need a browser skip otherwise). */
export async function chromiumAvailable(): Promise<boolean> {
  try {
    const browser = await chromium.launch({
      executablePath: process.env["SWARM_CHROMIUM_PATH"],
      args: ["--no-sandbox"],
    });
    await browser.close();
    return true;
  } catch {
    return false;
  }
}
