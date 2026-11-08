import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ContentionError, createJson, getJson, updateJson } from "./json.js";
import { MemoryStore } from "./memory.js";
import { PrefixedStore, PreconditionFailedError } from "./store.js";

const counter = z.object({ n: z.number() });

describe("MemoryStore conditional writes", () => {
  it("If-None-Match creates only when absent", async () => {
    const store = new MemoryStore();
    await store.put("a", "1", { ifNoneMatch: true });
    await expect(store.put("a", "2", { ifNoneMatch: true })).rejects.toBeInstanceOf(
      PreconditionFailedError,
    );
    expect((await store.get("a"))?.body).toBe("1");
  });

  it("If-Match only writes the current etag", async () => {
    const store = new MemoryStore();
    const { etag } = await store.put("a", "1");
    await store.put("a", "2", { ifMatch: etag });
    await expect(store.put("a", "3", { ifMatch: etag })).rejects.toBeInstanceOf(
      PreconditionFailedError,
    );
    await expect(store.put("missing", "x", { ifMatch: etag })).rejects.toBeInstanceOf(
      PreconditionFailedError,
    );
  });
});

describe("updateJson", () => {
  it("creates, updates and retries on a lost race without losing increments", async () => {
    const store = new MemoryStore();
    await Promise.all(
      Array.from({ length: 25 }, () =>
        updateJson(store, "c.json", counter, (c) => ({ n: (c?.n ?? 0) + 1 }), { retries: 60 }),
      ),
    );
    expect((await getJson(store, "c.json", counter))?.value.n).toBe(25);
  });

  it("leaves the object alone when the update returns undefined", async () => {
    const store = new MemoryStore();
    expect(await updateJson(store, "x.json", counter, () => undefined)).toBeNull();
    expect(await store.get("x.json")).toBeNull();
  });

  it("gives up with ContentionError when the retry budget is spent", async () => {
    const store = new MemoryStore();
    const racing = {
      get: store.get.bind(store),
      list: store.list.bind(store),
      delete: store.delete.bind(store),
      put: async () => {
        throw new PreconditionFailedError("k");
      },
    };
    await expect(
      updateJson(racing, "k", counter, () => ({ n: 1 }), { retries: 2 }),
    ).rejects.toBeInstanceOf(ContentionError);
  });
});

describe("createJson", () => {
  it("reports whether it won", async () => {
    const store = new MemoryStore();
    expect(await createJson(store, "k", { a: 1 })).toBe(true);
    expect(await createJson(store, "k", { a: 2 })).toBe(false);
  });
});

describe("PrefixedStore", () => {
  it("scopes reads, writes, lists and deletes to its prefix", async () => {
    const inner = new MemoryStore();
    const scoped = new PrefixedStore(inner, "_test/run-1/");
    await scoped.put("users/a.json", "x");
    expect(await inner.list("")).toEqual(["_test/run-1/users/a.json"]);
    expect(await scoped.list("users/")).toEqual(["users/a.json"]);
    await scoped.delete("users/a.json");
    expect(await inner.list("")).toEqual([]);
  });
});
