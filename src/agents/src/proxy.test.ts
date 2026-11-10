import http from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { checkResolved, decide, scopePorts, type Scope } from "./policy.js";
import { createProxy, type ScopeProxy } from "./proxy.js";

const scope: Scope = {
  hosts: ["app.example.com", "www.example.com"],
  ports: [80, 443],
  readOnly: true,
};

describe("decide (the allow-list)", () => {
  it.each([
    ["an allowed host", "GET", "app.example.com", 443, true],
    ["a second allowed host", "GET", "www.example.com", 80, true],
    ["the host in a different case", "GET", "APP.Example.com", 443, true],
    ["a trailing dot", "GET", "app.example.com.", 443, true],
    ["a CONNECT tunnel to an allowed host", "CONNECT", "app.example.com", 443, true],
    ["OPTIONS (a preflight)", "OPTIONS", "app.example.com", 443, true],
    ["another host", "GET", "evil.example.net", 443, false],
    ["a sibling subdomain", "GET", "api.example.com", 443, false],
    ["a look-alike suffix", "GET", "app.example.com.evil.net", 443, false],
    ["the cloud metadata address", "GET", "169.254.169.254", 80, false],
    ["the ECS credentials address", "GET", "169.254.170.2", 80, false],
    ["an RFC1918 address", "GET", "10.0.0.5", 80, false],
    ["loopback", "GET", "localhost", 80, false],
    ["a port that was not declared", "GET", "app.example.com", 22, false],
    ["POST while read-only", "POST", "app.example.com", 443, false],
    ["DELETE while read-only", "DELETE", "app.example.com", 443, false],
  ])("%s", (_name, method, host, port, allowed) => {
    expect(decide({ method, host, port }, scope).allow).toBe(allowed);
  });

  it("lets POST through when the run is not read-only", () => {
    expect(
      decide({ method: "POST", host: "app.example.com", port: 443 }, { ...scope, readOnly: false })
        .allow,
    ).toBe(true);
  });

  it("names the reason it refuses", () => {
    expect(decide({ method: "GET", host: "x.test", port: 80 }, scope)).toEqual({
      allow: false,
      reason: "host_not_in_scope",
    });
    expect(decide({ method: "POST", host: "app.example.com", port: 80 }, scope)).toEqual({
      allow: false,
      reason: "method_not_allowed",
    });
  });
});

describe("checkResolved (what DNS answered)", () => {
  it.each([
    ["a public address", ["93.184.216.34"], true],
    ["metadata", ["169.254.169.254"], false],
    ["ECS credentials", ["169.254.170.2"], false],
    ["RFC1918 10/8", ["10.1.2.3"], false],
    ["RFC1918 172.16/12", ["172.20.0.1"], false],
    ["RFC1918 192.168/16", ["192.168.1.1"], false],
    ["loopback", ["127.0.0.1"], false],
    ["IPv6 loopback", ["::1"], false],
    ["IPv6 unique local", ["fd00:ec2::254"], false],
    ["IPv4-mapped metadata", ["::ffff:169.254.169.254"], false],
    ["one private answer among public ones", ["93.184.216.34", "10.0.0.1"], false],
    ["no answer", [], false],
  ])("%s", (_name, addresses, ok) => {
    expect(checkResolved(addresses).ok).toBe(ok);
  });

  it("allows private addresses only when asked (local development)", () => {
    expect(checkResolved(["127.0.0.1"], { allowPrivate: true }).ok).toBe(true);
  });
});

describe("scopePorts", () => {
  it("adds the ports named in the URLs to 80 and 443", () => {
    expect(scopePorts(["https://a.example.com", "http://b.example.com:8080/x", ""])).toEqual([
      80, 443, 8080,
    ]);
  });
});

/** A real target on loopback, answering with its own host header and a redirect when asked. */
async function startTarget(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.url === "/redirect-out") {
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
      return res.end();
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`hello ${req.method} ${req.url}`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function viaProxy(
  proxyPort: number,
  url: string,
  method = "GET",
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; block: string | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: proxyPort,
        method,
        path: url,
        headers: { host: new URL(url).host, ...extraHeaders },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            block: res.headers["x-swarm-block"] as string | undefined,
            body,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("scope proxy", () => {
  const open: Array<{ close: () => Promise<void> }> = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((c) => c.close()));
  });

  async function setup(overrides: Partial<Parameters<typeof createProxy>[0]> = {}) {
    const target = await startTarget();
    const proxy: ScopeProxy = createProxy({
      scope: { hosts: ["app.test", "meta.test"], ports: [target.port, 80], readOnly: true },
      requestsPerSecond: 1000,
      requestCap: 100,
      // app.test resolves to the local target; meta.test to the metadata address.
      resolve: async (host) => (host === "meta.test" ? ["169.254.169.254"] : ["127.0.0.1"]),
      allowPrivate: false,
      ...overrides,
    });
    const port = await proxy.listen(0);
    open.push(target, proxy);
    return { target, proxy, port };
  }

  it("refuses an address that resolves to a private range even for a declared host", async () => {
    // Loopback is private, so even the declared app.test is refused without allowPrivate.
    const { target, proxy, port } = await setup();
    const res = await viaProxy(port, `http://app.test:${target.port}/`);
    expect(res.status).toBe(403);
    expect(res.block).toBe("address_blocked");
    expect(proxy.stats().blocked).toBe(1);
  });

  it("forwards an allowed request and logs it", async () => {
    const { target, proxy, port } = await setup({ allowPrivate: true });
    const res = await viaProxy(port, `http://app.test:${target.port}/page`);
    expect(res).toMatchObject({ status: 200, body: "hello GET /page" });
    expect(proxy.log().entries).toEqual([
      expect.objectContaining({
        method: "GET",
        host: "app.test",
        path: "/page",
        decision: "allowed",
        status: 200,
      }),
    ]);
    expect(proxy.stats().requests).toBe(1);
    // The request line and headers are counted as bytes sent, as well as the response coming back.
    expect(proxy.stats().bytesOut).toBeGreaterThan(20);
    expect(proxy.stats().bytesIn).toBe("hello GET /page".length);
  });

  it.each([
    ["a host outside the scope", "http://other.test/", "GET", "host_not_in_scope"],
    ["the metadata IP literal", "http://169.254.169.254/latest/", "GET", "host_not_in_scope"],
    [
      "the ECS credentials IP literal",
      "http://169.254.170.2/v2/credentials",
      "GET",
      "host_not_in_scope",
    ],
    ["an RFC1918 literal", "http://10.0.0.5/", "GET", "host_not_in_scope"],
    ["a port that was not declared", "http://app.test:22/", "GET", "port_not_allowed"],
    ["POST while read-only", "http://app.test/", "POST", "method_not_allowed"],
  ])("refuses %s", async (_name, url, method, reason) => {
    const { target, proxy, port } = await setup({ allowPrivate: true });
    void target;
    const res = await viaProxy(port, url, method);
    expect(res.status).toBe(403);
    expect(res.block).toBe(reason);
    expect(proxy.log().entries.at(-1)).toMatchObject({ decision: "blocked", reason });
  });

  it("refuses a declared host that resolves to the metadata address", async () => {
    const { proxy, port } = await setup({ allowPrivate: false });
    const res = await viaProxy(port, "http://meta.test/");
    expect(res).toMatchObject({ status: 403, block: "address_blocked" });
    expect(proxy.stats().blocked).toBe(1);
  });

  it("does not follow a redirect to an out-of-scope host: the next hop is refused", async () => {
    const { target, port } = await setup({ allowPrivate: true });
    const first = await viaProxy(port, `http://app.test:${target.port}/redirect-out`);
    expect(first.status).toBe(302);
    const next = await viaProxy(port, "http://169.254.169.254/latest/meta-data/");
    expect(next.status).toBe(403);
    expect(next.block).toBe("host_not_in_scope");
  });

  it("lets only the sign-in through while read-only: a POST with the run's key, up to the allowance", async () => {
    const { target, proxy, port } = await setup({
      allowPrivate: true,
      loginKey: "secret-key",
      loginSubmissions: 1,
    });
    const url = `http://app.test:${target.port}/api/login`;
    // Without the key, or with the wrong one, a write is refused like any other.
    expect((await viaProxy(port, url, "POST")).block).toBe("method_not_allowed");
    expect((await viaProxy(port, url, "POST", { "x-swarm-login": "guess" })).block).toBe(
      "method_not_allowed",
    );
    // With the key it goes through once, and the key does not reach the target.
    const ok = await viaProxy(port, url, "POST", { "x-swarm-login": "secret-key" });
    expect(ok).toMatchObject({ status: 200, body: "hello POST /api/login" });
    expect(proxy.log().entries.at(-1)).toMatchObject({
      method: "POST",
      decision: "allowed",
      reason: "login_submission",
    });
    // The allowance is used up: a second submission is refused, and so is any other write method.
    expect((await viaProxy(port, url, "POST", { "x-swarm-login": "secret-key" })).block).toBe(
      "method_not_allowed",
    );
    expect((await viaProxy(port, url, "DELETE", { "x-swarm-login": "secret-key" })).block).toBe(
      "method_not_allowed",
    );
  });

  it("never lets a sign-in key open a write to a host outside the scope", async () => {
    const { proxy, port } = await setup({
      allowPrivate: true,
      loginKey: "secret-key",
      loginSubmissions: 5,
    });
    const res = await viaProxy(port, "http://other.test/api/login", "POST", {
      "x-swarm-login": "secret-key",
    });
    expect(res).toMatchObject({ status: 403, block: "host_not_in_scope" });
    expect(proxy.log().entries.at(-1)).toMatchObject({ decision: "blocked" });
  });

  it("caps the total number of requests", async () => {
    const { target, port } = await setup({ allowPrivate: true, requestCap: 2 });
    const url = `http://app.test:${target.port}/`;
    expect((await viaProxy(port, url)).status).toBe(200);
    expect((await viaProxy(port, url)).status).toBe(200);
    const third = await viaProxy(port, url);
    expect(third.status).toBe(403);
    expect(third.block).toBe("request_cap_reached");
  });

  it("spaces requests to the per-run rate limit", async () => {
    const waits: number[] = [];
    let clock = 0;
    const { target, port } = await setup({
      allowPrivate: true,
      requestsPerSecond: 2,
      now: () => clock,
      sleep: async (ms) => {
        waits.push(ms);
        clock += ms;
      },
    });
    const url = `http://app.test:${target.port}/`;
    for (let i = 0; i < 5; i++) await viaProxy(port, url);
    // Two requests burst, then each further one waits for a token.
    expect(waits.length).toBeGreaterThanOrEqual(2);
    expect(waits.every((ms) => ms > 0 && ms <= 500)).toBe(true);
  });

  it("refuses a CONNECT tunnel to a host that is not in scope", async () => {
    const { port } = await setup({ allowPrivate: true });
    const status = await new Promise<{ code: number; block?: string }>((resolve, reject) => {
      const req = http.request({
        host: "127.0.0.1",
        port,
        method: "CONNECT",
        path: "169.254.169.254:80",
      });
      req.once("connect", (res, socket) => {
        socket.destroy();
        resolve({ code: res.statusCode ?? 0, block: res.headers["x-swarm-block"] as string });
      });
      req.once("error", reject);
      req.end();
    });
    expect(status).toEqual({ code: 403, block: "host_not_in_scope" });
  });
});
