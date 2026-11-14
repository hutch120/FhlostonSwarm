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

describe.skipIf(!browserAvailable)("sign-in with a one-time code field", () => {
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
    expect(result.message).toContain("answered 401");
  });

  async function start(verifyStatus: number) {
    const posted: string[] = [];
    const server = http.createServer((req, res) => {
      if (req.method === "POST") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          posted.push(body);
          if (verifyStatus === 303) res.writeHead(303, { location: "/home" }).end();
          else res.writeHead(verifyStatus, { "content-type": "text/html" }).end(PAGE);
        });
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(req.url === "/home" ? "<title>Home</title><h1>Dashboard</h1>" : PAGE);
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
      loginSubmissions: 1,
      loginKey: "key",
    });
    const proxyPort = await proxy.listen(0);
    open.push(() => proxy.close());
    const driver = await PlaywrightDriver.launch({
      proxy: { host: "127.0.0.1", port: proxyPort, loginKey: "key" },
      hosts: ["app.test"],
      loginSubmissions: 1,
      userAgent: "test",
    });
    open.push(() => driver.close());
    return { driver, posted, port };
  }
});
