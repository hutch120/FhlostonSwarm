import { createHash } from "node:crypto";
import {
  PreconditionFailedError,
  type ObjectStore,
  type PutCondition,
  type StoredObject,
} from "./store.js";

/** In-memory store with the same conditional-write semantics as S3, for unit tests and local dev. */
export class MemoryStore implements ObjectStore {
  private readonly objects = new Map<string, StoredObject>();

  async get(key: string): Promise<StoredObject | null> {
    const found = this.objects.get(key);
    return found ? { ...found } : null;
  }

  async put(key: string, body: string, condition?: PutCondition): Promise<{ etag: string }> {
    const existing = this.objects.get(key);
    if (condition && "ifNoneMatch" in condition && existing) throw new PreconditionFailedError(key);
    if (condition && "ifMatch" in condition && existing?.etag !== condition.ifMatch)
      throw new PreconditionFailedError(key);
    const etag = `"${createHash("md5").update(body).digest("hex")}-${this.objects.size}-${Math.random().toString(36).slice(2)}"`;
    this.objects.set(key, { body, etag });
    return { etag };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
  }

  async folders(prefix: string): Promise<string[]> {
    const found = new Set<string>();
    for (const key of this.objects.keys()) {
      if (!key.startsWith(prefix)) continue;
      const slash = key.indexOf("/", prefix.length);
      if (slash >= 0) found.add(key.slice(0, slash + 1));
    }
    return [...found].sort();
  }
}
