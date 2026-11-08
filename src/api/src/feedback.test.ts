import { describe, expect, it } from "vitest";
import { recordFeedback } from "./feedback.js";
import { emailHash, parseEmail } from "./identity.js";
import { keys } from "./storage/keys.js";
import { MemoryStore } from "./storage/memory.js";

const PEPPER = "pepper";
const hashOf = (address: string) => emailHash(PEPPER, parseEmail(address)!);

describe("SES feedback to suppression entries", () => {
  it("suppresses permanent bounces by hash only", async () => {
    const store = new MemoryStore();
    const written = await recordFeedback(
      store,
      PEPPER,
      {
        eventType: "Bounce",
        bounce: {
          bounceType: "Permanent",
          bouncedRecipients: [{ emailAddress: "bounce@simulator.amazonses.com" }],
        },
      },
      5,
    );
    expect(written).toBe(1);
    const stored = (await store.get(keys.suppression(hashOf("bounce@simulator.amazonses.com"))))!
      .body;
    expect(JSON.parse(stored)).toEqual({ reason: "bounce", at: 5, test: true });
    expect(stored).not.toContain("simulator");
  });

  it("suppresses complaints", async () => {
    const store = new MemoryStore();
    await recordFeedback(
      store,
      PEPPER,
      {
        eventType: "Complaint",
        complaint: { complainedRecipients: [{ emailAddress: "Angry+x@Example.com" }] },
      },
      7,
    );
    expect(await store.get(keys.suppression(hashOf("angry@example.com")))).not.toBeNull();
  });

  it("ignores transient bounces, other events and junk", async () => {
    const store = new MemoryStore();
    expect(
      await recordFeedback(
        store,
        PEPPER,
        {
          eventType: "Bounce",
          bounce: {
            bounceType: "Transient",
            bouncedRecipients: [{ emailAddress: "a@example.com" }],
          },
        },
        1,
      ),
    ).toBe(0);
    expect(await recordFeedback(store, PEPPER, { eventType: "Delivery" }, 1)).toBe(0);
    expect(await recordFeedback(store, PEPPER, "garbage", 1)).toBe(0);
    expect(await store.list("")).toEqual([]);
  });

  it("an existing suppression entry is kept", async () => {
    const store = new MemoryStore();
    const event = {
      eventType: "Complaint",
      complaint: { complainedRecipients: [{ emailAddress: "a@example.com" }] },
    };
    await recordFeedback(store, PEPPER, event, 1);
    await recordFeedback(store, PEPPER, event, 2);
    expect(JSON.parse((await store.get(keys.suppression(hashOf("a@example.com"))))!.body).at).toBe(
      1,
    );
  });
});
