import { randomBytes } from "node:crypto";
import http from "node:http";

/**
 * A small, deliberately vulnerable web app for testing the swarm against (PLAN.md section 14). Every
 * weakness here is on purpose and listed in expected.json. Never deploy it where real data lives:
 * the users and passwords below are test fixtures, named `swarm-test-*`.
 */
export interface FixtureUser {
  id: number;
  username: string;
  password: string;
  role: "admin" | "user";
  email: string;
  note: string;
}

export const USERS: readonly FixtureUser[] = [
  {
    id: 1,
    username: "swarm-test-admin",
    password: "swarm-test-admin-password",
    role: "admin",
    email: "admin@synthetic.invalid",
    note: "Synthetic administrator",
  },
  {
    id: 2,
    username: "swarm-test-user1",
    password: "swarm-test-user1-password",
    role: "user",
    email: "user1@synthetic.invalid",
    note: "Synthetic customer one",
  },
  {
    id: 3,
    username: "swarm-test-user2",
    password: "swarm-test-user2-password",
    role: "user",
    email: "user2@synthetic.invalid",
    note: "Synthetic customer two",
  },
];

const LOGIN_PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Synthetic target</title></head>
<body>
<h1>Synthetic target</h1>
<p>A deliberately vulnerable test application for Swarm. Sign in with a swarm-test- account.</p>
<form method="post" action="/api/login">
<label>Username <input name="username"></label>
<label>Password <input name="password" type="password"></label>
<button type="submit">Sign in</button>
</form>
</body>
</html>
`;

const GIT_CONFIG = `[core]
\trepositoryformatversion = 0
\tfilemode = true
[remote "origin"]
\turl = https://git.synthetic.invalid/portal.git
`;

/** Builds the server. `tokens` maps a bearer token to the user it was issued to. */
export function createTarget(): http.Server {
  const tokens = new Map<string, FixtureUser>();

  const send = (
    res: http.ServerResponse,
    status: number,
    body: string,
    headers: http.OutgoingHttpHeaders = {},
  ) => {
    res.writeHead(status, { "content-type": "text/plain; charset=utf-8", ...headers });
    res.end(body);
  };
  const json = (res: http.ServerResponse, status: number, value: unknown) =>
    send(res, status, JSON.stringify(value), { "content-type": "application/json" });

  const server = http.createServer(async (req, res) => {
    // Weakness: any Origin is reflected, with credentials allowed.
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("access-control-allow-credentials", "true");
    }

    try {
      const rawPath = (req.url ?? "/").split("?")[0] ?? "/";
      // Weakness: a malformed escape throws and the stack trace goes to the client.
      const path = decodeURIComponent(rawPath);

      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE",
          "access-control-allow-headers":
            String(req.headers["access-control-request-headers"] ?? "") || "*",
        });
        res.end();
        return;
      }

      if (path === "/healthz") return send(res, 200, "ok");

      if (path === "/" && req.method === "GET") {
        // Weakness: no security headers, and a session cookie without HttpOnly, Secure or SameSite.
        return send(res, 200, LOGIN_PAGE, {
          "content-type": "text/html; charset=utf-8",
          "set-cookie": `session=${randomBytes(8).toString("hex")}; Path=/`,
        });
      }

      // Weakness: the repository metadata is served.
      if (path === "/.git/HEAD") return send(res, 200, "ref: refs/heads/main\n");
      if (path === "/.git/config") return send(res, 200, GIT_CONFIG);

      if (path === "/api/login" && req.method === "POST") {
        let body = "";
        for await (const chunk of req) body += chunk;
        const given = (() => {
          try {
            return JSON.parse(body) as { username?: string; password?: string };
          } catch {
            return Object.fromEntries(new URLSearchParams(body)) as Record<string, string>;
          }
        })();
        const user = USERS.find(
          (u) => u.username === given.username && u.password === given.password,
        );
        if (!user) return json(res, 401, { error: "invalid_credentials" });
        const token = randomBytes(16).toString("hex");
        tokens.set(token, user);
        return json(res, 200, { token, role: user.role });
      }

      const bearer = /^Bearer (\S+)$/.exec(String(req.headers.authorization ?? ""))?.[1];
      const caller = bearer ? tokens.get(bearer) : undefined;

      const byId = /^\/api\/users\/(\d+)$/.exec(path);
      if (byId && req.method === "GET") {
        if (!caller) return json(res, 401, { error: "unauthenticated" });
        // Weakness (IDOR): any signed-in user can read any user's record.
        const user = USERS.find((u) => u.id === Number(byId[1]));
        if (!user) return json(res, 404, { error: "not_found" });
        return json(res, 200, { id: user.id, email: user.email, role: user.role, note: user.note });
      }

      if (path === "/api/admin/users" && req.method === "GET") {
        if (caller?.role !== "admin") return json(res, 403, { error: "forbidden" });
        return json(
          res,
          200,
          USERS.map(({ id, username, role }) => ({ id, username, role })),
        );
      }

      return send(res, 404, "Not found");
    } catch (err) {
      return send(res, 500, `${(err as Error).stack ?? String(err)}\n`);
    }
  });
  return server;
}
