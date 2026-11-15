import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProxy } from "../proxy.js";
import { PlaywrightDriver } from "./playwright.js";
import { browserAvailable } from "../testkit.js";

vi.setConfig({ testTimeout: 60_000 });

// The application's own sign-in page: an email box and a code box that is not a password field.
const PAGE = `<!doctype html><title>Sign in</title><form method="post" action="/verify">
<label>Email address <input name="email" type="email"></label>
<label>6-digit code or test passcode <input name="code" autocomplete="one-time-code"></label>
<button type="button">Email me a code</button><button type="submit">Sign in</button></form>`;

describe.skipIf(!browserAvailable)("signing in to the application under test", () => {
  const open: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const close of open.splice(0).reverse()) await close();
  });

  it("fills the email and the code, and signs in", async () => {
    const { driver, posted, port } = await start(303);
    const form = await driver.open(`http://app.test:${port}/`);
    expect(form.hasPasswordField).toBe(true);
    const result = await driver.signIn({ username: "me@example.com", password: "abcd-efgh" });

    expect(result.ok).toBe(true);
    expect(new URL(result.landedUrl).pathname).toBe("/home");
    expect(posted).toEqual(["email=me%40example.com&code=abcd-efgh"]);
  });

  it("says the application refused the login when it answers 401", async () => {
    const { driver, port } = await start(401);
    await driver.open(`http://app.test:${port}/`);
    const result = await driver.signIn({ username: "me@example.com", password: "abcd-efgh" });

    expect(result.ok).toBe(false);
    expect(result.obstacle).toBe("refused");
    expect(result.message).toContain("answered 401");
  });

  const PASSWORD_FORM = (extra = "") => `<!doctype html><title>Sign in</title>${extra}
<form method="post" action="/login"><label>Username <input name="username"></label>
<label>Password <input name="password" type="password"></label><button type="submit">Sign in</button></form>`;
  const login = { username: "me", password: "s3cret-pass" };

  it("signs in on a single username and password form", async () => {
    const { driver, posted, port } = await start(303, { "/": PASSWORD_FORM() });
    await driver.open(`http://app.test:${port}/`);
    const result = await driver.signIn(login);

    expect(result).toMatchObject({ ok: true, obstacle: null });
    expect(posted).toEqual(["username=me&password=s3cret-pass"]);
  });

  it("signs in on a username step followed by a password step", async () => {
    const { driver, posted, port } = await start(303, {
      "/": `<title>Sign in</title><form method="post" action="/step1"><label>Email <input name="email" type="email"></label><button>Next</button></form>`,
      "/password": `<title>Password</title><form method="post" action="/login"><label>Password <input name="password" type="password"></label><button type="submit">Sign in</button></form>`,
    });
    await driver.open(`http://app.test:${port}/`);
    const result = await driver.signIn({ username: "me@example.com", password: "s3cret-pass" });

    expect(result).toMatchObject({ ok: true, obstacle: null });
    expect(posted).toEqual(["email=me%40example.com", "password=s3cret-pass"]);
  });

  it("clears a cookie banner that covers the form", async () => {
    const banner = `<div id="cookie-banner" style="position:fixed;inset:0;background:#fff;z-index:9"><button id="accept" type="button">Accept all</button></div>
<script>document.getElementById("accept").onclick = () => document.getElementById("cookie-banner").remove();</script>`;
    const { driver, port } = await start(303, { "/": PASSWORD_FORM(banner) });
    await driver.open(`http://app.test:${port}/`);
    const result = await driver.signIn(login);

    expect(result).toMatchObject({ ok: true, obstacle: null });
  });

  it("names single sign-on when the page offers nothing else", async () => {
    const { driver, posted, port } = await start(303, {
      "/": `<title>Sign in</title><a href="/sso">Continue with Google</a> <a href="/sso">Sign in with SSO</a>`,
    });
    await driver.open(`http://app.test:${port}/`);
    const result = await driver.signIn(login);

    expect(result).toMatchObject({ ok: false, obstacle: "sso" });
    expect(posted).toEqual([]);
  });

  it("names a second factor when a code is asked for after the password", async () => {
    const { driver, port } = await start(200, {
      "/": PASSWORD_FORM(),
      "/after": `<title>Verify</title><p>Enter the 6-digit code from your authenticator app.</p>
<form method="post" action="/otp"><input name="otp" autocomplete="one-time-code"><button type="submit">Verify</button></form>`,
    });
    await driver.open(`http://app.test:${port}/`);
    const result = await driver.signIn(login);

    expect(result).toMatchObject({ ok: false, obstacle: "second-factor" });
  });

  it("names a CAPTCHA that stops the sign-in", async () => {
    const widget = `<div class="g-recaptcha" data-sitekey="test"></div>`;
    const { driver, port } = await start(200, { "/": PASSWORD_FORM(widget) });
    await driver.open(`http://app.test:${port}/`);
    const result = await driver.signIn(login);

    expect(result).toMatchObject({ ok: false, obstacle: "captcha" });
  });

  it("says the form is still showing when the sign-in does not take and nothing explains why", async () => {
    const { driver, port } = await start(200, { "/": PASSWORD_FORM() });
    await driver.open(`http://app.test:${port}/`);
    const result = await driver.signIn(login);

    expect(result).toMatchObject({ ok: false, obstacle: "still-showing" });
  });

  it("names a missing form on a page that has no sign-in", async () => {
    const { driver, posted, port } = await start(303, {
      "/": `<title>About</title><form action="/search"><input name="q" placeholder="Search"></form>`,
    });
    await driver.open(`http://app.test:${port}/`);
    const result = await driver.signIn(login);

    expect(result).toMatchObject({ ok: false, obstacle: "no-form" });
    expect(posted).toEqual([]);
  });

  async function start(verifyStatus: number, pages: Record<string, string> = {}) {
    const site: Record<string, string> = {
      "/": PAGE,
      "/home": "<title>Home</title><h1>Dashboard</h1>",
      ...pages,
    };
    const posted: string[] = [];
    const server = http.createServer((req, res) => {
      const path = (req.url ?? "/").split("?")[0]!;
      if (req.method === "POST") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          posted.push(body);
          if (path === "/step1") res.writeHead(303, { location: "/password" }).end();
          else if (verifyStatus === 303) res.writeHead(303, { location: "/home" }).end();
          else {
            res
              .writeHead(verifyStatus, { "content-type": "text/html" })
              .end(site["/after"] ?? site["/"]);
          }
        });
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(site[path as keyof typeof site] ?? PAGE);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    open.push(
      () => new Promise((resolve) => (server.closeAllConnections(), server.close(() => resolve()))),
    );
    const proxy = createProxy({
      scope: { hosts: ["app.test"], ports: [port], readOnly: true },
      requestsPerSecond: 1000,
      requestCap: 100,
      resolve: async () => ["127.0.0.1"],
      allowPrivate: true,
      loginSubmissions: 2,
      loginKey: "key",
    });
    const proxyPort = await proxy.listen(0);
    open.push(() => proxy.close());
    const driver = await PlaywrightDriver.launch({
      proxy: { host: "127.0.0.1", port: proxyPort, loginKey: "key" },
      hosts: ["app.test"],
      loginSubmissions: 2,
      userAgent: "test",
    });
    open.push(() => driver.close());
    return { driver, posted, port };
  }
});
