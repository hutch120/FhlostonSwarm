import type { z } from "zod";
import { PreconditionFailedError, type ObjectStore } from "./store.js";

export interface Versioned<T> {
  value: T;
  etag: string;
}

/** The compare-and-swap retry budget ran out: too many concurrent writers on one key. */
export class ContentionError extends Error {
  constructor(key: string) {
    super(`Too much contention writing ${key}`);
    this.name = "ContentionError";
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function getJson<S extends z.ZodType>(
  store: ObjectStore,
  key: string,
  schema: S,
): Promise<Versioned<z.infer<S>> | null> {
  const found = await store.get(key);
  if (!found) return null;
  return { value: schema.parse(JSON.parse(found.body)), etag: found.etag };
}

/** Create-only write: false when the key already exists (`If-None-Match: *`). */
export async function createJson(
  store: ObjectStore,
  key: string,
  value: unknown,
): Promise<boolean> {
  try {
    await store.put(key, JSON.stringify(value), { ifNoneMatch: true });
    return true;
  } catch (err) {
    if (err instanceof PreconditionFailedError) return false;
    throw err;
  }
}

export async function putJson(store: ObjectStore, key: string, value: unknown): Promise<void> {
  await store.put(key, JSON.stringify(value));
}

export interface UpdateOptions {
  retries?: number;
}

/**
 * Compare-and-swap read-modify-write. `update` receives the current value (null if absent) and
 * returns the next value, or `undefined` to leave the object untouched. On a lost race the whole
 * read-modify-write is retried, so `update` must be pure. Returns the value that was written (or
 * the unchanged current value).
 */
export async function updateJson<S extends z.ZodType>(
  store: ObjectStore,
  key: string,
  schema: S,
  update: (current: z.infer<S> | null) => z.infer<S> | undefined,
  { retries = 12 }: UpdateOptions = {},
): Promise<z.infer<S> | null> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const current = await getJson(store, key, schema);
    const next = update(current?.value ?? null);
    if (next === undefined) return current?.value ?? null;
    try {
      await store.put(
        key,
        JSON.stringify(next),
        current ? { ifMatch: current.etag } : { ifNoneMatch: true },
      );
      return next;
    } catch (err) {
      if (!(err instanceof PreconditionFailedError)) throw err;
      await sleep(Math.random() * 15 * (attempt + 1));
    }
  }
  throw new ContentionError(key);
}
