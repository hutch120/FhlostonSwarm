import { serve } from "@hono/node-server";
import { PlaywrightDriver, createOfflineLlm } from "@swarm/agents";
import { createTarget, USERS } from "@swarm/synthetic-target";
import { Hono } from "hono";
import { TERMS_VERSION, TIER_IDS, tierIdSchema } from "@swarm/shared";
import { createApp } from "./app.js";
import { authConfig } from "./config.js";
import { grantCredits } from "./credits.js";
import { emailHash, parseEmail } from "./identity.js";
import { newId } from "./ids.js";
import { LocalLauncher } from "./local-launcher.js";
import { FakeMailer } from "./mailer.js";
import { MemoryPublisher } from "./publisher.js";
import { putJson } from "./storage/json.js";
import { keys } from "./storage/keys.js";
import { MemoryStore } from "./storage/memory.js";
import type { StoredTarget } from "./targets.js";

/**
 * Local API for `npm run dev -w src/api`: in-memory storage, no AWS, and mail is collected instead
 * of sent. The last mail per address is readable at /__dev/mail (sign-in), /__dev/deletion-code
 * and /__dev/confirmation, /__dev/grant adds credits, and /__dev/seed-target saves a target that
 * points at the synthetic target running next to this server, so e2e tests can drive every flow,
 * including a real run (the agent runs in this process, with no AWS). Never deployed.
 */
const port = Number(process.env["PORT"] ?? 8787);
const syntheticPort = Number(process.env["SYNTHETIC_PORT"] ?? 8090);
const siteOrigin = process.env["SITE_ORIGIN"] ?? "http://localhost:5173";
const mailer = new FakeMailer();
const store = new MemoryStore();
const publisher = new MemoryPublisher();
const pepper = "dev-pepper-not-a-secret";
const secrets = async () => ({
  pepper,
  jwtKey: new TextEncoder().encode("dev-jwt-key-not-a-secret-0123456789"),
});

createTarget().listen(syntheticPort, "127.0.0.1");

const launcher = new LocalLauncher({
  store,
  secrets,
  publisher,
  allowPrivate: true,
  // Offline: every name points at this machine, where only the synthetic target listens.
  resolve: async () => ["127.0.0.1"],
  // A scripted model and a real local Chromium: the whole explorer pipeline, with no Bedrock.
  llm: () => createOfflineLlm(),
  driverFactory: (options) => PlaywrightDriver.launch(options),
  pollMs: 200,
  finalize: { store, mailer, publisher, now: Date.now, siteOrigin },
});

const api = createApp({
  store,
  secrets,
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
  launcher,
  publisher,
  presign: async (key, { filename }) =>
    `http://localhost:${port}/__dev/object?key=${encodeURIComponent(key)}&name=${encodeURIComponent(filename)}`,
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
// The intake refuses loopback addresses, so the local synthetic target is saved directly.
server.post("/__dev/seed-target", async (c) => {
  const body = (await c.req.json()) as { to?: string };
  const email = parseEmail(body.to ?? "");
  if (!email) return c.json({ error: "bad_request" }, 400);
  const at = Date.now();
  const user = USERS[1]!;
  const target: StoredTarget = {
    test: true,
    id: newId("tgt", at),
    appUrl: `http://127.0.0.1:${syntheticPort}/`,
    marketingUrl: "",
    scopeNotes: "Local synthetic target",
    hosts: ["127.0.0.1"],
    logins: {
      user1: {
        username: user.username,
        password: user.password,
        description: "Synthetic customer one",
        notes: "",
      },
    },
    acknowledgement: { at, ip: "127.0.0.1", termsVersion: TERMS_VERSION },
    createdAt: at,
    updatedAt: at,
  };
  await putJson(store, keys.target(emailHash(pepper, email), target.id), target);
  return c.json({ targetId: target.id });
});
server.get("/__dev/object", async (c) => {
  const found = await store.get(c.req.query("key") ?? "");
  if (!found) return c.json({ error: "not_found" }, 404);
  return new Response(found.body, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-disposition": `attachment; filename="${c.req.query("name") ?? "report.html"}"`,
    },
  });
});
server.route("/", api);

serve({ fetch: server.fetch, port }, () => {
  console.log(`Swarm dev API on http://localhost:${port} (site origin ${siteOrigin})`);
  console.log(`Synthetic target on http://127.0.0.1:${syntheticPort}`);
});
