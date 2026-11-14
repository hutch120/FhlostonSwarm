import type { LearningStorage } from "./layer.js";

/** A precondition (`If-None-Match` or `If-Match`) did not hold; the layer treats it as a lost race. */
class PreconditionFailedError extends Error {
  constructor(key: string) {
    super(`Precondition failed for ${key}`);
    this.name = "PreconditionFailedError";
  }
}

/** An in-memory store with the data bucket's conditional writes, for tests and local tools. */
export class MemoryLearningStorage implements LearningStorage {
  private readonly objects = new Map<string, { body: string; etag: string }>();
  private counter = 0;

  async get(key: string) {
    const found = this.objects.get(key);
    return found ? { ...found } : null;
  }

  async put(
    key: string,
    body: string,
    condition?: { ifNoneMatch: true } | { ifMatch: string },
  ): Promise<{ etag: string }> {
    const existing = this.objects.get(key);
    if (condition && "ifNoneMatch" in condition && existing) throw new PreconditionFailedError(key);
    if (condition && "ifMatch" in condition && existing?.etag !== condition.ifMatch) {
      throw new PreconditionFailedError(key);
    }
    this.counter += 1;
    const etag = `"e${this.counter}"`;
    this.objects.set(key, { body, etag });
    return { etag };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
  }
}
