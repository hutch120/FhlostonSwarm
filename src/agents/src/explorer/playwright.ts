import {
  chromium,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
  type Response,
} from "playwright-core";
import type { SignInObstacle } from "@swarm/shared";
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
/** A username box: never the one-time-code box that takes a passcode. */
const USER_FIELD = [
  "input[type=email]:visible",
  "input[type=text]:visible",
  "input[type=tel]:visible",
  "input:not([type]):visible",
]
  .map((s) => `${s}:not([autocomplete=one-time-code])`)
  .join(", ");
/** How long a sign-in step waits for the page to react before it looks at the result. */
const SIGN_IN_WAIT_MS = 8000;
const COOKIE_ACCEPT =
  /^\s*(accept|accept all|accept cookies|accept all cookies|agree|i agree|allow all|allow cookies|ok|okay|got it)\s*$/i;
const LOGIN_NAME = /user|e-?mail|log-?in|account|member|phone|identifier/i;
const CODE_NAME = /otp|code|token|2fa|mfa|verif|authenticator/i;
const SECOND_FACTOR_TEXT =
  /verification code|authenticator|one-time|two-factor|2fa|\bmfa\b|security code|enter the (?:\d-?digit |6-?digit )?code/i;
const SSO_TEXT =
  /(?:continue|sign\s*in|log\s*in|login)\s+(?:with|using|via)\s+(?:google|microsoft|okta|azure|entra|apple|github|sso|saml|your (?:company|organi[sz]ation))|single sign.?on|\bsso\b/i;
const CAPTCHA_SELECTOR =
  ".g-recaptcha, .h-captcha, .cf-turnstile, [data-sitekey], iframe[src*='recaptcha'], iframe[src*='hcaptcha'], iframe[src*='challenges.cloudflare.com']";

/** What the sign-in logic needs to know about the page. No values are read. */
interface PageState {
  password: number;
  /** A code box is showing together with wording that asks for a second factor. */
  codePrompt: boolean;
  captcha: boolean;
  /** The page offers a single sign-on button or link. */
  sso: boolean;
}

/** Runs in the page, for the sign-in logic. */
const INSPECT = `(() => {
  const visible = (e) => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
  const all = (selector) => [...document.querySelectorAll(selector)].filter(visible);
  const name = (e) => [e.name, e.id, e.placeholder, e.getAttribute("aria-label"), ...[...(e.labels || [])].map((l) => l.textContent)].join(" ");
  const codeBoxes = all("input:not([type=password]):not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button])")
    .filter((e) => e.autocomplete === "one-time-code" || ${CODE_NAME}.test(name(e)));
  const text = document.body ? document.body.innerText : "";
  const clickable = all("a, button, [role=button], input[type=submit], input[type=button]")
    .map((e) => (e.textContent || e.value || "").replace(/\\s+/g, " ").trim());
  return {
    password: all("input[type=password]").length,
    codePrompt: codeBoxes.length > 0 && ${SECOND_FACTOR_TEXT}.test(text),
    captcha: !!document.querySelector(${JSON.stringify(CAPTCHA_SELECTOR)}),
    sso: clickable.some((t) => ${SSO_TEXT}.test(t)),
  };
})()`;

/** True when a field looks like a username or email box, not a search box or other input. */
const isLoginName = (field: Locator): Promise<boolean> =>
  field.evaluate((el, source) => {
    const input = el as HTMLInputElement;
    const label = [
      input.name,
      input.id,
      input.placeholder,
      input.autocomplete,
      input.getAttribute("aria-label") ?? "",
      ...[...(input.labels ?? [])].map((l) => l.textContent ?? ""),
    ].join(" ");
    return input.type === "email" || new RegExp(source, "i").test(label);
  }, LOGIN_NAME.source);

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
    // A refused submission is the application saying the login is wrong, not a form the agent missed.
    const posts: number[] = [];
    const onResponse = (response: Response) => {
      if (response.request().method() === "POST") posts.push(response.status());
    };
    page.on("response", onResponse);
    this.loginWindow = true;
    try {
      return await this.attemptSignIn(login, posts);
    } finally {
      this.loginWindow = false;
      page.off("response", onResponse);
    }
  }

  private async attemptSignIn(
    login: { username: string; password: string },
    posts: number[],
  ): Promise<SignInResult> {
    const { page } = this;
    const result = (
      obstacle: SignInObstacle | null,
      message: string,
      extra: { snapshot?: PageSnapshot | null; insecureTransport?: boolean } = {},
    ): SignInResult => ({
      ok: obstacle === null,
      obstacle,
      message,
      landedUrl: page.url(),
      insecureTransport: extra.insecureTransport ?? false,
      snapshot: extra.snapshot ?? null,
    });
    /** The status of the last submission, when the application answered it with an error. */
    const refusedStatus = (): number | undefined => {
      const last = posts.at(-1);
      return last !== undefined && last >= 400 ? last : undefined;
    };
    const refusedNote = () =>
      `The application refused the supplied login (it answered ${refusedStatus()}), so the username and password or passcode saved for it are wrong or have expired.`;
    const withoutSecret = (state: PageState | null): SignInResult => {
      if (state?.sso) {
        return result(
          "sso",
          "The page offers only single sign-on (Google, Microsoft, Okta or similar), not a username and password form.",
        );
      }
      if (state?.captcha) {
        return result("captcha", "The sign-in page shows a CAPTCHA widget.");
      }
      if (refusedStatus() !== undefined) return result("refused", refusedNote());
      return result(
        "no-form",
        "No password or passcode field is visible on this page. It may not be the sign-in page, or the application may sign in some other way (an emailed link or single sign-on).",
      );
    };

    await this.dismissCookieBanner();
    let secret = page.locator(SECRET_FIELD).first();
    let twoStep = false;
    if ((await secret.count()) === 0) {
      const first = page.locator(USER_FIELD).first();
      const state = await this.inspect();
      if ((await first.count()) === 0 || !(await isLoginName(first))) return withoutSecret(state);
      // A username-only first step: submit it, then wait for the password or passcode step.
      await first.fill(login.username);
      await this.submit(first);
      await this.waitUntil(async () => (await page.locator(SECRET_FIELD).count()) > 0);
      secret = page.locator(SECRET_FIELD).first();
      if ((await secret.count()) === 0) return withoutSecret(await this.inspect());
      twoStep = true;
    }

    const secretIsPassword = (await secret.getAttribute("type")) === "password";
    const form = secret.locator("xpath=ancestor::form[1]");
    const scope = (await form.count()) > 0 ? form : page.locator("body");
    const user = twoStep ? null : scope.locator(USER_FIELD).first();
    if (user && (await user.count()) === 0) {
      return result("no-form", "The sign-in form has no username field.");
    }

    const action =
      (await form.count()) > 0
        ? await form.evaluate((f) => (f as HTMLFormElement).action)
        : page.url();
    const insecureTransport = new URL(action || page.url()).protocol === "http:";

    await user?.fill(login.username);
    await secret.fill(login.password);
    const before = page.url();
    await this.submit(secret, scope);
    await this.waitUntil(
      async () =>
        page.url() !== before ||
        (await page.locator(SECRET_FIELD).count()) === 0 ||
        (secretIsPassword && (await page.locator("input[type=password]:visible").count()) === 0),
    );
    await page.waitForLoadState("load", { timeout: 5000 }).catch(() => undefined);
    await page.waitForLoadState("networkidle", { timeout: 2500 }).catch(() => undefined);

    const snapshot = await this.snapshot(200).catch(() => null);
    const state = await this.inspect().catch(() => null);
    const extra = { snapshot, insecureTransport };
    if (secretIsPassword && state && state.password === 0 && state.codePrompt) {
      return result(
        "second-factor",
        "After the username and password, the application asked for a code (a second factor).",
        extra,
      );
    }
    const stillThere = snapshot?.hasPasswordField ?? false;
    if (stillThere && state?.captcha) {
      return result("captcha", "The sign-in did not succeed and the page shows a CAPTCHA.", extra);
    }
    if (refusedStatus() !== undefined) return result("refused", refusedNote(), extra);
    if (!stillThere) return result(null, "Signed in.", extra);
    return result(
      "still-showing",
      page.url() === before
        ? "The sign-in form is still showing, so the sign-in did not succeed."
        : "The page after the sign-in still shows a password field.",
      extra,
    );
  }

  /** What the sign-in logic reads from the page; no form values. */
  private async inspect(): Promise<PageState> {
    return (await this.page.evaluate(INSPECT)) as PageState;
  }

  /** Clicks a visible cookie-consent "Accept/Agree/OK" button that could cover the sign-in form. */
  private async dismissCookieBanner(): Promise<void> {
    const button = this.page
      .locator("button:visible, a[role=button]:visible, [role=button]:visible")
      .filter({ hasText: COOKIE_ACCEPT })
      .first();
    if ((await button.count()) === 0) return;
    await button.click({ timeout: 2000 }).catch(() => undefined);
    await this.page.waitForTimeout(250);
  }

  /** Clicks the form's own submit button, or presses Enter in the field when it has none. */
  private async submit(field: Locator, scope?: Locator): Promise<void> {
    const form = scope ?? field.locator("xpath=ancestor::form[1]");
    const button = form
      .locator(
        "button[type=submit]:visible, input[type=submit]:visible, button:not([type]):visible",
      )
      .first();
    if ((await button.count()) > 0) await button.click({ timeout: 5000 });
    else await field.press("Enter");
  }

  /** Polls until `done` or the bounded wait ends. */
  private async waitUntil(done: () => Promise<boolean>): Promise<void> {
    for (let waited = 0; waited < SIGN_IN_WAIT_MS; waited += 250) {
      await this.page.waitForTimeout(250);
      try {
        if (await done()) return;
      } catch {
        // The page is navigating; look again on the next pass.
      }
    }
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
