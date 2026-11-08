import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createApp } from "./app.js";
import { authConfig } from "./config.js";
import { FakeMailer } from "./mailer.js";
import { MemoryStore } from "./storage/memory.js";

/**
 * Local API for `npm run dev -w src/api`: in-memory storage, no AWS, and mail is collected instead
 * of sent. The last mail per address is readable at /__dev/mail so e2e tests can sign in.
 * Never deployed.
 */
const port = Number(process.env["PORT"] ?? 8787);
const siteOrigin = process.env["SITE_ORIGIN"] ?? "http://localhost:5173";
const mailer = new FakeMailer();

const api = createApp({
  store: new MemoryStore(),
  secrets: async () => ({
    pepper: "dev-pepper-not-a-secret",
    jwtKey: new TextEncoder().encode("dev-jwt-key-not-a-secret-0123456789"),
  }),
  mailer,
  config: {
    ...authConfig,
    minRequestMs: 0,
    // Local e2e runs sign in many times from one address.
    rateLimits: {
      requestPerEmailPerHour: 1000,
      requestPerIpPerHour: 1000,
      verifyPerIpPerHour: 1000,
    },
  },
  siteOrigin,
  cookieSecure: false,
});

const server = new Hono();
server.get("/__dev/mail", (c) => {
  const mail = mailer.lastTo((c.req.query("to") ?? "").toLowerCase());
  return mail ? c.json(mail) : c.json({ error: "no_mail" }, 404);
});
server.route("/", api);

serve({ fetch: server.fetch, port }, () => {
  console.log(`Swarm dev API on http://localhost:${port} (site origin ${siteOrigin})`);
});
