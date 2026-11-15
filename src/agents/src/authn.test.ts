import { SIGN_IN_OBSTACLES, loginHelp, type SignInObstacle } from "@swarm/shared";
import { describe, expect, it } from "vitest";
import { authnAgent } from "./agents/authn.js";
import type { SignInRecord } from "./explorer/explorer.js";
import type { StepContext } from "./types.js";

const attempt = (slot: string, obstacle: SignInObstacle | null): SignInRecord => ({
  slot,
  description: slot === "admin" ? "Administrator" : "Customer",
  ok: obstacle === null,
  obstacle,
  insecureTransport: false,
  landedPath: "/",
  message: "",
  cookies: [],
  before: [],
});

const contextWith = (signIns: SignInRecord[]) =>
  ({
    input: { logins: { admin: {}, user1: {} } },
    appUrl: new URL("https://staging.example.com/"),
    explorer: {
      exploreSignedIn: async () => ({ end: "done", pages: 0 }),
      signIns,
    },
  }) as unknown as StepContext;

describe("the sign-in review's gaps", () => {
  it.each(SIGN_IN_OBSTACLES)("tells the owner the fix for %s", async (obstacle) => {
    const result = await authnAgent.steps["login"]!(contextWith([attempt("admin", obstacle)]));

    expect(result).toMatchObject({ outcome: "gap" });
    const reason = (result as { reason: string }).reason;
    expect(reason).toContain(loginHelp[obstacle]);
    expect(reason).not.toContain("supply a test account");
  });

  it("names a login that did not sign in when another one did", async () => {
    const result = await authnAgent.steps["login"]!(
      contextWith([attempt("admin", null), attempt("user1", "sso")]),
    );

    expect(result).toMatchObject({ outcome: "info" });
    const gaps = (result as { gaps: string[] }).gaps;
    expect(gaps).toEqual([expect.stringContaining(loginHelp.sso)]);
  });
});
