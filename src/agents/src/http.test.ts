import type net from "node:net";
import https from "node:https";
import { afterEach, describe, expect, it } from "vitest";
import { Budget } from "./budget.js";
import { ScopedHttp } from "./http.js";
import { createProxy } from "./proxy.js";

// A throwaway self-signed certificate for localhost, used only by this test's loopback server.
const KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgeRXA9K6oO+zf/6m1
vSTrS/sKwUyezjebLIT54vjpF+2hRANCAAQbHExX1kYZb3xzmqL/0+uMn30+byle
l0iBidCsnC8I5Ja7GX631tVe3dYvZkPVw23V84rqUPfdkZkuta+pgSjv
-----END PRIVATE KEY-----`;
const CERT = `-----BEGIN CERTIFICATE-----
MIIBmzCCAUGgAwIBAgIUShRTxYNpAiTJTicCrQHzYC71ohgwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTExNDA3NTU0MloYDzIxMjYxMDIx
MDc1NTQyWjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAAQbHExX1kYZb3xzmqL/0+uMn30+bylel0iBidCsnC8I5Ja7GX631tVe
3dYvZkPVw23V84rqUPfdkZkuta+pgSjvo28wbTAdBgNVHQ4EFgQUofAYbVFUgcnm
h4HKkFTY4u5SVQMwHwYDVR0jBBgwFoAUofAYbVFUgcnmh4HKkFTY4u5SVQMwDwYD
VR0TAQH/BAUwAwEB/zAaBgNVHREEEzARgglsb2NhbGhvc3SHBH8AAAEwCgYIKoZI
zj0EAwIDSAAwRQIgMuBKGdlE0F57GN71pQeWpJHiKz4SvBR4KIrDWlyQCDsCIQCx
STwr9ETjbPnmjY91Z94gUeP5R5AzO3v34p2fZ2MlAA==
-----END CERTIFICATE-----`;

describe("ScopedHttp over HTTPS", () => {
  const open: Array<{ close: () => Promise<void> }> = [];
  afterEach(async () => {
    for (const item of open.splice(0)) await item.close();
  });

  it("tunnels through the proxy and reads the response on the secured socket", async () => {
    const server = https.createServer({ key: KEY, cert: CERT }, (req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`secure ${req.method} ${req.url}`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const targetPort = (server.address() as net.AddressInfo).port;
    const proxy = createProxy({
      scope: { hosts: ["app.test"], ports: [targetPort], readOnly: true },
      requestsPerSecond: 1000,
      requestCap: 100,
      resolve: async () => ["127.0.0.1"],
      allowPrivate: true,
    });
    const proxyPort = await proxy.listen(0);
    open.push(
      {
        close: () =>
          new Promise((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      },
      proxy,
    );

    const budget = new Budget(
      { maxSteps: 10, maxRequests: 10, deadline: Date.now() + 30_000 },
      Date.now,
    );
    const http = new ScopedHttp({ host: "127.0.0.1", port: proxyPort }, "test-agent", budget);
    const res = await http.request({ url: `https://app.test:${targetPort}/page?x=1` });

    expect(res).toMatchObject({ status: 200, body: "secure GET /page?x=1" });
    expect(res.tls?.protocol).toMatch(/^TLSv1\./);
    expect(proxy.log().entries).toEqual([
      expect.objectContaining({ method: "CONNECT", host: "app.test", decision: "allowed" }),
    ]);
  });
});
