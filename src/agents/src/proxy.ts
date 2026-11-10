import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import type { ProxyLogEntry, ProxyStats } from "@swarm/shared/server";
import { checkResolved, decide, normaliseHost, type Denial, type Scope } from "./policy.js";
import { TokenBucket } from "./ratelimit.js";

/** The header that carries the sign-in key (set by the agent's browser, stripped here). */
export const LOGIN_HEADER = "x-swarm-login";

export interface ProxyOptions {
  scope: Scope;
  requestsPerSecond: number;
  /** Hard cap on requests (and tunnels) through the proxy; beyond it everything is refused. */
  requestCap: number;
  /** Local development only: lets the proxy reach loopback and private addresses. */
  allowPrivate?: boolean;
  /** Sign-in POSTs let through while read-only, when they carry `loginKey` in `x-swarm-login`. */
  loginSubmissions?: number;
  loginKey?: string;
  resolve?: (host: string) => Promise<string[]>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  maxLogEntries?: number;
}

export interface ScopeProxy {
  server: http.Server;
  listen(port: number, host?: string): Promise<number>;
  close(): Promise<void>;
  stats(): ProxyStats;
  log(): { entries: ProxyLogEntry[]; dropped: number };
}

const HOP_BY_HOP = new Set([
  "connection",
  "proxy-connection",
  "proxy-authorization",
  "keep-alive",
  "te",
  "trailer",
  "upgrade",
]);

const defaultResolve = async (host: string): Promise<string[]> =>
  (await dnsLookup(host, { all: true })).map((a) => a.address);

const IDLE_MS = 30_000;

/**
 * The scope proxy: the only way the agent reaches the network. It allows the declared hosts and
 * ports, refuses anything that resolves to a private, link-local, metadata or ECS-credentials
 * address, refuses non-safe methods when the run is read-only (plain HTTP; a TLS tunnel cannot be
 * inspected, so the tool layer only issues safe methods), rate limits, caps the total and logs
 * every decision. It does not follow redirects: each hop is a new request the agent makes, so a
 * redirect to an out-of-scope host is refused like any other.
 */
export function createProxy(options: ProxyOptions): ScopeProxy {
  const now = options.now ?? Date.now;
  const resolve = options.resolve ?? defaultResolve;
  const bucket = new TokenBucket(options.requestsPerSecond, now, options.sleep);
  const maxLog = options.maxLogEntries ?? 5000;
  const startedAt = now();
  const entries: ProxyLogEntry[] = [];
  let dropped = 0;
  let requests = 0;
  let blocked = 0;
  let bytesOut = 0;
  let bytesIn = 0;
  let loginUsed = 0;

  const record = (entry: Omit<ProxyLogEntry, "ts">) => {
    if (entries.length >= maxLog) {
      dropped += 1;
      return;
    }
    entries.push({ ts: new Date(now()).toISOString(), ...entry });
  };

  const refuse = (
    target: { method: string; host: string; port: number; path: string },
    reason: Denial,
  ) => {
    blocked += 1;
    record({ ...target, decision: "blocked", reason });
  };

  /** Policy, cap, rate limit and DNS in one step; returns the pinned address or the reason. */
  async function admit(
    target: {
      method: string;
      host: string;
      port: number;
      path: string;
    },
    scope: Scope = options.scope,
  ): Promise<{ ok: true; address: string } | { ok: false; reason: Denial }> {
    const verdict = decide(target, scope);
    if (!verdict.allow) return { ok: false, reason: verdict.reason };
    if (requests >= options.requestCap) return { ok: false, reason: "request_cap_reached" };
    requests += 1;
    await bucket.take();
    let addresses: string[];
    try {
      addresses = await resolve(normaliseHost(target.host));
    } catch {
      return { ok: false, reason: "address_blocked" };
    }
    const picked = checkResolved(addresses, { allowPrivate: options.allowPrivate });
    return picked.ok ? picked : { ok: false, reason: picked.reason };
  }

  const server = http.createServer(async (req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "");
    } catch {
      refuse({ method: req.method ?? "", host: "", port: 0, path: "" }, "bad_request");
      res.writeHead(400, { "x-swarm-block": "bad_request" }).end();
      return;
    }
    const method = (req.method ?? "GET").toUpperCase();
    const port = Number(url.port) || 80;
    const target = { method, host: url.hostname, port, path: url.pathname };
    if (url.protocol !== "http:") {
      refuse(target, "bad_request");
      res.writeHead(400, { "x-swarm-block": "bad_request" }).end();
      return;
    }
    // A sign-in POST carries the run's key; nothing else may write. The key never goes upstream.
    const signIn =
      method === "POST" &&
      options.loginKey !== undefined &&
      req.headers[LOGIN_HEADER] === options.loginKey &&
      loginUsed < (options.loginSubmissions ?? 0);
    const admitted = await admit(
      target,
      signIn ? { ...options.scope, readOnly: false } : undefined,
    );
    if (!admitted.ok) {
      refuse(target, admitted.reason);
      res.writeHead(403, { "x-swarm-block": admitted.reason }).end();
      return;
    }
    if (signIn) loginUsed += 1;

    const headers = Object.fromEntries(
      Object.entries(req.headers).filter(
        ([name]) => !HOP_BY_HOP.has(name) && name !== LOGIN_HEADER,
      ),
    );
    const upstream = http.request(
      {
        host: admitted.address,
        port,
        method,
        path: url.pathname + url.search,
        headers: { ...headers, host: url.host, connection: "close" },
        timeout: IDLE_MS,
      },
      (response) => {
        record({
          ...target,
          decision: "allowed",
          status: response.statusCode,
          ...(signIn ? { reason: "login_submission" } : {}),
        });
        const outgoing = Object.fromEntries(
          Object.entries(response.headers).filter(([name]) => !HOP_BY_HOP.has(name)),
        );
        res.writeHead(response.statusCode ?? 502, outgoing);
        response.on("data", (chunk: Buffer) => (bytesIn += chunk.length));
        response.pipe(res);
      },
    );
    req.on("data", (chunk: Buffer) => (bytesOut += chunk.length));
    // The request line and headers count too: for a GET they are all there is.
    bytesOut += Buffer.byteLength(
      `${method} ${url.pathname + url.search} HTTP/1.1\r\n` +
        Object.entries(headers)
          .map(([name, value]) => `${name}: ${String(value)}\r\n`)
          .join(""),
    );
    upstream.on("timeout", () => upstream.destroy(new Error("upstream timeout")));
    upstream.on("error", () => {
      record({ ...target, decision: "allowed", status: 502 });
      if (!res.headersSent) res.writeHead(502, { "x-swarm-block": "upstream_error" });
      res.end();
    });
    req.pipe(upstream);
  });

  server.on("connect", async (req, client: Duplex) => {
    const [rawHost = "", rawPort = ""] = (req.url ?? "").split(/:(?=[^:]*$)/);
    const port = Number(rawPort);
    const target = { method: "CONNECT", host: rawHost, port, path: "" };
    const admitted = await admit(target);
    if (!admitted.ok) {
      refuse(target, admitted.reason);
      client.end(`HTTP/1.1 403 Forbidden\r\nx-swarm-block: ${admitted.reason}\r\n\r\n`);
      return;
    }
    const upstream = net.connect({ host: admitted.address, port });
    upstream.setTimeout(IDLE_MS, () => upstream.destroy());
    upstream.once("connect", () => {
      record({ ...target, decision: "allowed", status: 200 });
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.on("data", (chunk: Buffer) => (bytesIn += chunk.length));
      client.on("data", (chunk: Buffer) => (bytesOut += chunk.length));
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", () => {
      record({ ...target, decision: "allowed", status: 502 });
      client.end("HTTP/1.1 502 Bad Gateway\r\nx-swarm-block: upstream_error\r\n\r\n");
    });
    client.on("error", () => upstream.destroy());
    client.on("close", () => upstream.destroy());
  });

  return {
    server,
    listen: (port, host = "127.0.0.1") =>
      new Promise((resolveListen, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolveListen((server.address() as net.AddressInfo).port);
        });
      }),
    close: () =>
      new Promise((resolveClose) => {
        server.closeAllConnections();
        server.close(() => resolveClose());
      }),
    stats: () => ({
      uptimeSeconds: Math.max(0, (now() - startedAt) / 1000),
      requests,
      blocked,
      bytesOut,
      bytesIn,
    }),
    log: () => ({ entries: [...entries], dropped }),
  };
}
