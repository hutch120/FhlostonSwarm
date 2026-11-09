import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { TIER_IDS, tierIdSchema } from "@swarm/shared";
import { createApp } from "./app.js";
import { authConfig } from "./config.js";
import { grantCredits } from "./credits.js";
import { emailHash, parseEmail } from "./identity.js";
import { FakeMailer } from "./mailer.js";
import { MemoryStore } from "./storage/memory.js";

/**
 * Local API for `npm run dev -w src/api`: in-memory storage, no AWS, and mail is collected instead
 * of sent. The last mail per address is readable at /__dev/mail (sign-in), /__dev/deletion-code
 * and /__dev/confirmation, and /__dev/grant adds credits, so e2e tests can drive every flow.
 * Never deployed.
 */
const port = Number(process.env["PORT"] ?? 8787);
const siteOrigin = process.env["SITE_ORIGIN"] ?? "http://localhost:5173";
const mailer = new FakeMailer();
const store = new MemoryStore();
const pepper = "dev-pepper-not-a-secret";

const api = createApp({
  store,
  secrets: async () => ({
    pepper,
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
const to = (query: string | undefined) => (query ?? "").toLowerCase();
server.get("/__dev/mail", (c) => {
  const mail = mailer.lastTo(to(c.req.query("to")));
  return mail ? c.json(mail) : c.json({ error: "no_mail" }, 404);
});
server.get("/__dev/deletion-code", (c) => {
  const mail = mailer.lastDeletionCodeTo(to(c.req.query("to")));
  return mail ? c.json(mail) : c.json({ error: "no_mail" }, 404);
});
server.get("/__dev/confirmation", (c) => {
  const mail = mailer.lastConfirmationTo(to(c.req.query("to")));
  return mail ? c.json(mail) : c.json({ error: "no_mail" }, 404);
});
server.post("/__dev/grant", async (c) => {
  const body = (await c.req.json()) as { to?: string; tier?: string; count?: number };
  const email = parseEmail(body.to ?? "");
  const tier = tierIdSchema.safeParse(body.tier);
  if (!email || !tier.success) return c.json({ error: "bad_request", tiers: TIER_IDS }, 400);
  const credits = await grantCredits(
    store,
    emailHash(pepper, email),
    { tier: tier.data, count: body.count ?? 1, source: "comp", reason: "dev", by: "dev" },
    Date.now(),
  );
  return c.json(credits);
});
server.route("/", api);

serve({ fetch: server.fetch, port }, () => {
  console.log(`Swarm dev API on http://localhost:${port} (site origin ${siteOrigin})`);
});
