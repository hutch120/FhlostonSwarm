import http from "node:http";
import tls from "node:tls";
import type { Budget } from "./budget.js";
import { isSafeMethod } from "./policy.js";

export interface ProxyAddress {
  host: string;
  port: number;
}

export interface TlsDetails {
  authorized: boolean;
  authorizationError: string | null;
  protocol: string | null;
  cipher: string | null;
  validTo: string | null;
  subject: string | null;
  issuer: string | null;
}

export interface HttpResult {
  /** The URL of the last response (after redirects). */
  url: string;
  status: number;
  /** Lower-cased names; repeated headers are arrays. */
  headers: Record<string, string | string[]>;
  body: string;
  redirects: string[];
  tls: TlsDetails | null;
}

/** The request did not get an answer from the target: blocked by the proxy, refused, or timed out. */
export class RequestFailed extends Error {
  constructor(
    readonly reason: string,
    readonly blocked = false,
  ) {
    super(reason);
    this.name = "RequestFailed";
  }
}

export interface RequestOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  /** Follow up to this many redirects, each one a fresh request through the proxy. Default 5. */
  maxRedirects?: number;
}

export interface TlsProbeOptions {
  host: string;
  port: number;
  minVersion?: tls.SecureVersion;
  maxVersion?: tls.SecureVersion;
  ciphers?: string;
}

export type TlsProbeResult =
  ({ ok: true } & TlsDetails) | { ok: false; error: string; code: string | null };

const MAX_BODY_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;

const flatten = (headers: http.IncomingHttpHeaders): HttpResult["headers"] =>
  Object.fromEntries(
    Object.entries(headers).flatMap(([k, v]) => (v === undefined ? [] : [[k, v]])),
  ) as HttpResult["headers"];

const first = (value: string | string[] | undefined): string | null =>
  (Array.isArray(value) ? value[0] : value) ?? null;

const describePeer = (socket: tls.TLSSocket): TlsDetails => {
  const cert = socket.getPeerCertificate();
  const authError = socket.authorizationError;
  return {
    authorized: socket.authorized,
    authorizationError: authError ? String(authError) : null,
    protocol: socket.getProtocol(),
    cipher: socket.getCipher()?.name ?? null,
    validTo: cert && "valid_to" in cert ? cert.valid_to : null,
    subject: first(cert?.subject?.CN),
    issuer: first(cert?.issuer?.CN),
  };
};

/**
 * The agent's only way to reach the target: every request goes through the scope proxy, redirects are
 * followed one hop at a time (so each hop is checked), only safe methods are issued, and each request
 * is counted against the run budget. A TLS certificate that fails verification is reported, not fatal.
 */
export class ScopedHttp {
  constructor(
    private readonly proxy: ProxyAddress,
    private readonly userAgent: string,
    private readonly budget: Budget,
  ) {}

  async request(options: RequestOptions): Promise<HttpResult> {
    const method = (options.method ?? "GET").toUpperCase();
    if (!isSafeMethod(method)) throw new RequestFailed("method_not_allowed", true);
    const redirects: string[] = [];
    let url = options.url;
    const limit = options.maxRedirects ?? 5;
    for (;;) {
      this.budget.useRequest();
      const hop = await this.single(url, method, options.headers ?? {});
      const location = hop.headers["location"];
      const redirecting =
        [301, 302, 303, 307, 308].includes(hop.status) && typeof location === "string";
      if (!redirecting || redirects.length >= limit) return { ...hop, redirects };
      redirects.push(url);
      url = new URL(location, url).toString();
    }
  }

  /** Opens a tunnel through the proxy and negotiates TLS, to inspect protocol, cipher and certificate. */
  async tlsProbe(options: TlsProbeOptions): Promise<TlsProbeResult> {
    this.budget.useRequest();
    let socket;
    try {
      socket = await this.tunnel(options.host, options.port);
    } catch (err) {
      if (err instanceof RequestFailed) throw err;
      return {
        ok: false,
        error: (err as Error).message,
        code: (err as { code?: string }).code ?? null,
      };
    }
    return new Promise<TlsProbeResult>((resolve) => {
      const secure = tls.connect({
        socket,
        servername: options.host,
        rejectUnauthorized: false,
        minVersion: options.minVersion,
        maxVersion: options.maxVersion,
        ciphers: options.ciphers,
      });
      const done = (result: TlsProbeResult) => {
        secure.destroy();
        socket.destroy();
        resolve(result);
      };
      secure.setTimeout(REQUEST_TIMEOUT_MS, () =>
        done({ ok: false, error: "timeout", code: "ETIMEDOUT" }),
      );
      secure.once("secureConnect", () => done({ ok: true, ...describePeer(secure) }));
      secure.once("error", (err: NodeJS.ErrnoException) =>
        done({ ok: false, error: err.message, code: err.code ?? null }),
      );
    });
  }

  private tunnel(host: string, port: number): Promise<import("node:net").Socket> {
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: this.proxy.host,
        port: this.proxy.port,
        method: "CONNECT",
        path: `${host}:${port}`,
        headers: { host: `${host}:${port}`, "user-agent": this.userAgent },
        timeout: REQUEST_TIMEOUT_MS,
      });
      req.once("connect", (res, socket) => {
        if (res.statusCode === 200) return resolve(socket);
        socket.destroy();
        const reason = String(res.headers["x-swarm-block"] ?? `proxy_${res.statusCode}`);
        reject(new RequestFailed(reason, res.statusCode === 403));
      });
      req.once("timeout", () => req.destroy(new RequestFailed("timeout")));
      req.once("error", reject);
      req.end();
    });
  }

  private async single(
    rawUrl: string,
    method: string,
    extra: Record<string, string>,
  ): Promise<Omit<HttpResult, "redirects">> {
    const url = new URL(rawUrl);
    const secure = url.protocol === "https:";
    const port = Number(url.port) || (secure ? 443 : 80);
    const headers = {
      "user-agent": this.userAgent,
      accept: "*/*",
      "accept-encoding": "identity",
      connection: "close",
      ...extra,
      host: url.host,
    };

    let details: TlsDetails | null = null;
    let options: http.RequestOptions;
    if (secure) {
      const tunnelSocket = await this.tunnel(url.hostname, port);
      const socket = await new Promise<tls.TLSSocket>((resolve, reject) => {
        const s = tls.connect({
          socket: tunnelSocket,
          servername: url.hostname,
          rejectUnauthorized: false,
        });
        s.once("secureConnect", () => resolve(s));
        s.once("error", reject);
      });
      details = describePeer(socket);
      // Node ignores a bare `createConnection` option on `agent: false` and dials localhost:80 instead,
      // so the already-secured socket is handed over through a one-shot agent.
      const agent = new http.Agent({ keepAlive: false });
      agent.createConnection = () => socket;
      options = {
        agent,
        method,
        path: url.pathname + url.search,
        headers,
      };
    } else {
      options = {
        agent: false,
        host: this.proxy.host,
        port: this.proxy.port,
        method,
        path: url.toString(),
        headers,
      };
    }

    return new Promise((resolve, reject) => {
      const req = http.request({ ...options, timeout: REQUEST_TIMEOUT_MS }, (res) => {
        if (res.headers["x-swarm-block"] && res.statusCode && res.statusCode >= 400) {
          res.resume();
          const reason = String(res.headers["x-swarm-block"]);
          return reject(
            new RequestFailed(reason, res.statusCode === 403 || res.statusCode === 400),
          );
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          if (size >= MAX_BODY_BYTES) return;
          size += chunk.length;
          chunks.push(chunk);
        });
        res.on("end", () =>
          resolve({
            url: url.toString(),
            status: res.statusCode ?? 0,
            headers: flatten(res.headers),
            body: Buffer.concat(chunks).subarray(0, MAX_BODY_BYTES).toString("utf8"),
            tls: details,
          }),
        );
        res.on("error", reject);
      });
      req.once("timeout", () => req.destroy(new RequestFailed("timeout")));
      req.once("error", (err) =>
        reject(err instanceof RequestFailed ? err : new RequestFailed((err as Error).message)),
      );
      req.end();
    });
  }
}

/** First value of a header. */
export function header(result: Pick<HttpResult, "headers">, name: string): string | undefined {
  const value = result.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

/** Every value of a header (`set-cookie` repeats). */
export function headerValues(result: Pick<HttpResult, "headers">, name: string): string[] {
  const value = result.headers[name.toLowerCase()];
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}
