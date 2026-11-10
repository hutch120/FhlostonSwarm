import { header, type HttpResult } from "../http.js";
import type { AgentModule, StepContext, StepResult } from "../types.js";

const HSTS_MIN_SECONDS = 15_552_000; // 180 days
const CERT_WARN_DAYS = 14;

interface Endpoint {
  host: string;
  port: number;
}

/** Where TLS can be tested: the app URL if it is HTTPS, or the HTTPS page the app redirects to. */
async function tlsEndpoint(
  ctx: StepContext,
): Promise<{ endpoint: Endpoint; page: HttpResult | null } | null> {
  if (ctx.appUrl.protocol === "https:") {
    return {
      endpoint: { host: ctx.appUrl.hostname, port: Number(ctx.appUrl.port) || 443 },
      page: null,
    };
  }
  const page = await ctx.baseline();
  const finalUrl = new URL(page.url);
  if (finalUrl.protocol !== "https:") return null;
  return { endpoint: { host: finalUrl.hostname, port: Number(finalUrl.port) || 443 }, page };
}

const plainHttp = (ctx: StepContext): StepResult => ({
  outcome: "info",
  note: `Not applicable: ${ctx.appUrl.origin} is served over plain HTTP, so there is no TLS to review.`,
});

const WEAK_CIPHER = /RC4|3DES|DES-CBC|NULL|EXPORT|MD5|ANON/i;

async function protocols(ctx: StepContext): Promise<StepResult> {
  const found = await tlsEndpoint(ctx);
  if (!found) {
    return {
      outcome: "finding",
      finding: {
        title: "Application is served over plain HTTP",
        severity: "medium",
        component: ctx.appUrl.origin,
        description:
          "The application URL uses http:// and does not redirect to HTTPS, so traffic (including sign-in) can be read or altered on the network.",
        remediation:
          "Serve the application over HTTPS only and redirect all HTTP requests to HTTPS. Add HSTS once HTTPS works.",
        mapping: "OWASP A02:2021 Cryptographic Failures",
      },
    };
  }
  const legacy = await ctx.http.tlsProbe({
    ...found.endpoint,
    minVersion: "TLSv1",
    maxVersion: "TLSv1.1",
    ciphers: "ALL:@SECLEVEL=0",
  });
  if (legacy.ok) {
    return {
      outcome: "finding",
      finding: {
        title: `Legacy TLS version accepted (${legacy.protocol ?? "TLS 1.0/1.1"})`,
        severity: "medium",
        component: `${found.endpoint.host}:${found.endpoint.port}`,
        description:
          "The server completed a handshake using TLS 1.0 or 1.1, which are deprecated and have known weaknesses.",
        remediation: "Disable TLS 1.0 and 1.1; allow TLS 1.2 and 1.3 only.",
        mapping: "OWASP A02:2021 Cryptographic Failures",
      },
    };
  }
  if (
    /no protocols available|NO_PROTOCOLS|UNSUPPORTED_PROTOCOL/i.test(
      `${legacy.error} ${legacy.code}`,
    )
  ) {
    return {
      outcome: "info",
      note: "This scanner could not offer TLS 1.0/1.1, so legacy protocol support was not tested.",
    };
  }
  return { outcome: "clear" };
}

async function ciphers(ctx: StepContext): Promise<StepResult> {
  const found = await tlsEndpoint(ctx);
  if (!found) return plainHttp(ctx);
  const probe = await ctx.http.tlsProbe({ ...found.endpoint, minVersion: "TLSv1.2" });
  if (!probe.ok) {
    return {
      outcome: "gap",
      reason: `A modern TLS handshake with ${found.endpoint.host} failed (${probe.code ?? probe.error}).`,
    };
  }
  if (probe.cipher && WEAK_CIPHER.test(probe.cipher)) {
    return {
      outcome: "finding",
      finding: {
        title: `Weak cipher suite negotiated (${probe.cipher})`,
        severity: "medium",
        component: `${found.endpoint.host}:${found.endpoint.port}`,
        description: `The server negotiated ${probe.cipher}, which is considered weak.`,
        remediation:
          "Restrict the server to modern AEAD cipher suites (AES-GCM, ChaCha20-Poly1305).",
        mapping: "OWASP A02:2021 Cryptographic Failures",
      },
    };
  }
  return {
    outcome: "info",
    note: `Negotiated ${probe.protocol ?? "TLS"} with ${probe.cipher ?? "an unknown cipher"}. Only the negotiated suite was checked; a full cipher-suite review arrives with the TLS scanner.`,
  };
}

async function chain(ctx: StepContext): Promise<StepResult> {
  const found = await tlsEndpoint(ctx);
  if (!found) return plainHttp(ctx);
  const probe = await ctx.http.tlsProbe(found.endpoint);
  const component = `${found.endpoint.host}:${found.endpoint.port}`;
  if (!probe.ok) {
    return {
      outcome: "gap",
      reason: `The TLS handshake with ${component} failed (${probe.code ?? probe.error}).`,
    };
  }
  if (!probe.authorized) {
    return {
      outcome: "finding",
      finding: {
        title: "Certificate is not trusted",
        severity: "high",
        component,
        description: `The certificate chain did not validate: ${probe.authorizationError ?? "unknown error"}. Browsers will warn users or refuse to connect.`,
        remediation:
          "Install a certificate from a public CA that matches the hostname, with the full chain.",
        mapping: "OWASP A02:2021 Cryptographic Failures",
      },
    };
  }
  const expires = probe.validTo ? Date.parse(probe.validTo) : NaN;
  const days = Math.floor((expires - Date.now()) / 86_400_000);
  if (Number.isFinite(days) && days < CERT_WARN_DAYS) {
    return {
      outcome: "finding",
      finding: {
        title: `Certificate expires in ${Math.max(days, 0)} days`,
        severity: days < 0 ? "high" : "medium",
        component,
        description: `The certificate is valid until ${probe.validTo}.`,
        remediation: "Renew the certificate and automate renewal.",
      },
    };
  }
  return { outcome: "clear" };
}

async function hsts(ctx: StepContext): Promise<StepResult> {
  const found = await tlsEndpoint(ctx);
  if (!found) return plainHttp(ctx);
  const page = found.page ?? (await ctx.baseline());
  if (new URL(page.url).protocol !== "https:") return plainHttp(ctx);
  const value = header(page, "strict-transport-security");
  const component = `GET ${new URL(page.url).pathname}`;
  if (!value) {
    return {
      outcome: "finding",
      finding: {
        title: "HTTP Strict Transport Security (HSTS) is not set",
        severity: "medium",
        component,
        description:
          "Without HSTS, a browser can be downgraded to HTTP on the first visit or by an attacker on the network.",
        remediation:
          "Send Strict-Transport-Security: max-age=31536000; includeSubDomains on every HTTPS response.",
        mapping: "OWASP A05:2021 Security Misconfiguration",
      },
    };
  }
  const maxAge = Number(/max-age=(\d+)/i.exec(value)?.[1] ?? 0);
  if (maxAge < HSTS_MIN_SECONDS) {
    return {
      outcome: "finding",
      finding: {
        title: "HSTS max-age is short",
        severity: "low",
        component,
        description: `Strict-Transport-Security is set with max-age=${maxAge}, below the recommended six months.`,
        remediation: "Use a max-age of at least 15552000 seconds (one year is common).",
        mapping: "OWASP A05:2021 Security Misconfiguration",
      },
    };
  }
  return { outcome: "clear" };
}

export const tlsAgent: AgentModule = {
  id: "tls",
  task: "Check the transport: HTTPS, TLS versions, certificate and HSTS",
  steps: { protocols, ciphers, chain, hsts },
  doneSummary: ({ checks, findings }) =>
    `Transport review finished: ${checks} checks, ${findings} ${findings === 1 ? "issue" : "issues"}.`,
};
