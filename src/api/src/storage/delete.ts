import type { ObjectStore } from "./store.js";

/** Deletes every object under a prefix and returns how many there were. */
export async function deletePrefix(store: ObjectStore, prefix: string): Promise<number> {
  const found = await store.list(prefix);
  for (let i = 0; i < found.length; i += 25) {
    await Promise.all(found.slice(i, i + 25).map((key) => store.delete(key)));
  }
  return found.length;
}
