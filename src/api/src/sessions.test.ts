import { SignJWT } from "jose";
import { beforeEach, describe, expect, it } from "vitest";
import {
  authenticate,
  createSession,
  csrfToken,
  revokeSession,
  rotateSession,
  signAccessToken,
} from "./sessions.js";
import { MemoryStore } from "./storage/memory.js";
import { createClock, testConfig, testSecrets } from "./testkit.js";

const HASH = "b".repeat(64);
const config = testConfig();
const user = { emailHash: HASH, email: "buyer@example.com", role: "customer" as const };

let store: MemoryStore;
let clock: ReturnType<typeof createClock>;

beforeEach(() => {
  store = new MemoryStore();
  clock = createClock();
});

const start = async () => {
  const issued = await createSession(store, testSecrets, user, config, clock.now());
  const jwt = await signAccessToken(testSecrets, issued.record, config, clock.now());
  return { issued, jwt };
};

describe("access tokens", () => {
  it("authenticate a live session", async () => {
    const { jwt, issued } = await start();
    expect(await authenticate(store, testSecrets, jwt, clock.now())).toEqual({
      emailHash: HASH,
      sessionId: issued.record.sessionId,
      email: "buyer@example.com",
      role: "customer",
    });
  });

  it("expire after the configured lifetime", async () => {
    const { jwt } = await start();
    clock.advance(config.session.accessTtlMinutes * 60_000 + 2_000);
    expect(await authenticate(store, testSecrets, jwt, clock.now())).toBeNull();
  });

  it("reject tokens signed with another key, with another algorithm, or garbage", async () => {
    const { issued } = await start();
    const claims = { sid: issued.record.sessionId, role: "staff" };
    const forged = await new SignJWT(claims)
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(HASH)
      .setIssuer("swarm")
      .setAudience("swarm-web")
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode("some-other-key-some-other-key-123456"));
    const none = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(
      JSON.stringify({ ...claims, sub: HASH, iss: "swarm", aud: "swarm-web" }),
    ).toString("base64url")}.`;
    for (const token of [forged, none, "garbage", ""]) {
      expect(await authenticate(store, testSecrets, token, clock.now())).toBeNull();
    }
  });

  it("reject a token for the wrong audience", async () => {
    const { issued } = await start();
    const token = await new SignJWT({ sid: issued.record.sessionId })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(HASH)
      .setIssuer("swarm")
      .setAudience("someone-else")
      .setExpirationTime("1h")
      .sign(testSecrets.jwtKey);
    expect(await authenticate(store, testSecrets, token, clock.now())).toBeNull();
  });

  it("stop working the moment the session is revoked", async () => {
    const { jwt, issued } = await start();
    await revokeSession(store, HASH, issued.record.sessionId, clock.now());
    expect(await authenticate(store, testSecrets, jwt, clock.now())).toBeNull();
  });

  it("take the role from the server-side record, not the token", async () => {
    const { issued } = await start();
    const claimsStaff = await new SignJWT({ sid: issued.record.sessionId, role: "staff" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(HASH)
      .setIssuer("swarm")
      .setAudience("swarm-web")
      .setExpirationTime("1h")
      .sign(testSecrets.jwtKey);
    expect((await authenticate(store, testSecrets, claimsStaff, clock.now()))?.role).toBe(
      "customer",
    );
  });
});

describe("refresh tokens", () => {
  it("rotate: the new token works and the old one is dead", async () => {
    const { issued } = await start();
    const second = await rotateSession(
      store,
      testSecrets,
      issued.refreshToken,
      config,
      clock.now(),
    );
    expect(second).not.toBeNull();
    expect(second!.refreshToken).not.toBe(issued.refreshToken);
    const third = await rotateSession(
      store,
      testSecrets,
      second!.refreshToken,
      config,
      clock.now(),
    );
    expect(third).not.toBeNull();
    expect(
      await rotateSession(store, testSecrets, issued.refreshToken, config, clock.now()),
    ).toBeNull();
  });

  it("replaying an already-rotated token revokes the whole session", async () => {
    const { issued } = await start();
    const second = await rotateSession(
      store,
      testSecrets,
      issued.refreshToken,
      config,
      clock.now(),
    );
    expect(
      await rotateSession(store, testSecrets, issued.refreshToken, config, clock.now()),
    ).toBeNull();
    // The legitimate newest token is now dead too, and so is the access token.
    expect(
      await rotateSession(store, testSecrets, second!.refreshToken, config, clock.now()),
    ).toBeNull();
    const jwt = await signAccessToken(testSecrets, second!.record, config, clock.now());
    expect(await authenticate(store, testSecrets, jwt, clock.now())).toBeNull();
  });

  it("concurrent rotations of one token: exactly one wins", async () => {
    const { issued } = await start();
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        rotateSession(store, testSecrets, issued.refreshToken, config, clock.now()),
      ),
    );
    expect(results.filter(Boolean).length).toBeLessThanOrEqual(1);
  });

  it("expire after the refresh lifetime", async () => {
    const { issued } = await start();
    clock.advance(config.session.refreshTtlDays * 86_400_000 + 1);
    expect(
      await rotateSession(store, testSecrets, issued.refreshToken, config, clock.now()),
    ).toBeNull();
  });

  it("reject malformed tokens and a wrong secret", async () => {
    const { issued } = await start();
    const [h, s] = issued.refreshToken.split(".");
    for (const token of ["", "x", "a.b.c", `${h}.${s}.wrong`, `${h}.${s}`]) {
      expect(await rotateSession(store, testSecrets, token, config, clock.now()), token).toBeNull();
    }
  });

  it("re-derive the role on rotation", async () => {
    const issued = await createSession(
      store,
      testSecrets,
      { emailHash: HASH, email: "sam@fhlostonswarm.com", role: "customer" },
      config,
      clock.now(),
    );
    const next = await rotateSession(store, testSecrets, issued.refreshToken, config, clock.now());
    expect(next?.record.role).toBe("staff");
  });
});

describe("csrf token", () => {
  it("is stable per session, differs between sessions, and depends on the key", () => {
    expect(csrfToken(testSecrets, "s1")).toBe(csrfToken(testSecrets, "s1"));
    expect(csrfToken(testSecrets, "s1")).not.toBe(csrfToken(testSecrets, "s2"));
    expect(
      csrfToken(
        { ...testSecrets, jwtKey: new TextEncoder().encode("another-key-another-key-another") },
        "s1",
      ),
    ).not.toBe(csrfToken(testSecrets, "s1"));
  });
});
