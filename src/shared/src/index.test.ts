import { describe, expect, it } from "vitest";
import { err, ok, runIdSchema, userIdSchema } from "./index.js";

describe("ids", () => {
  it("accepts well-formed ids", () => {
    expect(runIdSchema.parse("run_abc12345")).toBe("run_abc12345");
    expect(userIdSchema.parse("usr_0123456789")).toBe("usr_0123456789");
  });

  it("rejects wrong prefix or malformed ids", () => {
    expect(runIdSchema.safeParse("usr_abc12345").success).toBe(false);
    expect(runIdSchema.safeParse("run_ABC").success).toBe(false);
  });
});

describe("Result", () => {
  it("builds ok and err values", () => {
    expect(ok(1)).toEqual({ ok: true, value: 1 });
    expect(err("boom")).toEqual({ ok: false, error: "boom" });
  });
});
