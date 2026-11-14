import { describe, expect, it } from "vitest";
import { authzAgent } from "./agents/authz.js";
import type { HttpResult } from "./http.js";
import type { StepContext } from "./types.js";

const reply = (status: number, body: string): HttpResult => ({
  url: "http://t.test/",
  status,
  headers: { "content-type": "text/html" },
  body,
  redirects: [],
  tls: null,
});

/** A signed-out visitor's view of a site: `pages` answer as given, every other path gets `fallback`. */
const siteFor = (pages: Record<string, HttpResult>, fallback: HttpResult) =>
  ({
    appUrl: new URL("http://t.test/"),
    http: {
      request: async ({ url }: { url: string }) => pages[new URL(url).pathname] ?? fallback,
    },
    explorer: null,
    plan: null,
    roles: () => [],
    shared: new Map(),
  }) as unknown as StepContext;

describe("authz: admin endpoint exposure", () => {
  const shell = reply(200, "<html><body><div id=root></div></body></html>");

  it("ignores a single-page app's catch-all, which answers every path with the same page", async () => {
    const result = await authzAgent.steps.admin!(siteFor({}, shell));
    expect(result.outcome).toBe("clear");
  });

  it("still reports an administrative page that differs from the catch-all", async () => {
    const ctx = siteFor({ "/admin": reply(200, "<html><h1>Users</h1> alice, bob</html>") }, shell);
    const result = await authzAgent.steps.admin!(ctx);
    expect(result.outcome).toBe("finding");
    if (result.outcome !== "finding") return;
    expect(result.finding.component).toBe("GET /admin");
    expect((await result.finding.replay!()).confirmed).toBe(true);
  });

  it("reports an open admin page on a site that returns 404 for unknown paths", async () => {
    const ctx = siteFor({ "/admin": reply(200, "<h1>Admin</h1>") }, reply(404, "not found"));
    expect((await authzAgent.steps.admin!(ctx)).outcome).toBe("finding");
  });
});
