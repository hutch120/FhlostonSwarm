import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

export interface StoredObject {
  body: string;
  etag: string;
}

/** Create-only (`If-None-Match: *`) or compare-and-swap (`If-Match: <etag>`). */
export type PutCondition = { ifNoneMatch: true } | { ifMatch: string };

/** A conditional write lost the race, or its precondition does not hold. */
export class PreconditionFailedError extends Error {
  constructor(key: string) {
    super(`Precondition failed for ${key}`);
    this.name = "PreconditionFailedError";
  }
}

export interface ObjectStore {
  get(key: string): Promise<StoredObject | null>;
  put(key: string, body: string, condition?: PutCondition): Promise<{ etag: string }>;
  /** Writes a binary object (the PDF report). */
  putBytes(key: string, body: Uint8Array, contentType: string): Promise<void>;
  /** Reads a binary object. */
  getBytes(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
  /** Every key under the prefix. */
  list(prefix: string): Promise<string[]>;
  /** The immediate "folders" under the prefix (each ends with `/`), without listing what is inside. */
  folders(prefix: string): Promise<string[]>;
}

/** Scopes a store to a key prefix, e.g. `_test/<runId>/` so tests never touch real data. */
export class PrefixedStore implements ObjectStore {
  constructor(
    private readonly inner: ObjectStore,
    private readonly prefix: string,
  ) {}
  get(key: string) {
    return this.inner.get(this.prefix + key);
  }
  put(key: string, body: string, condition?: PutCondition) {
    return this.inner.put(this.prefix + key, body, condition);
  }
  putBytes(key: string, body: Uint8Array, contentType: string) {
    return this.inner.putBytes(this.prefix + key, body, contentType);
  }
  getBytes(key: string) {
    return this.inner.getBytes(this.prefix + key);
  }
  delete(key: string) {
    return this.inner.delete(this.prefix + key);
  }
  async list(prefix: string) {
    const keys = await this.inner.list(this.prefix + prefix);
    return keys.map((k) => k.slice(this.prefix.length));
  }
  async folders(prefix: string) {
    const folders = await this.inner.folders(this.prefix + prefix);
    return folders.map((k) => k.slice(this.prefix.length));
  }
}

const statusOf = (err: unknown): number | undefined =>
  (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
const nameOf = (err: unknown): string | undefined => (err as { name?: string }).name;

export class S3ObjectStore implements ObjectStore {
  constructor(
    private readonly bucket: string,
    private readonly client = new S3Client({}),
  ) {}

  async get(key: string): Promise<StoredObject | null> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return { body: (await res.Body?.transformToString("utf-8")) ?? "", etag: res.ETag ?? "" };
    } catch (err) {
      if (nameOf(err) === "NoSuchKey" || statusOf(err) === 404) return null;
      throw err;
    }
  }

  async put(key: string, body: string, condition?: PutCondition): Promise<{ etag: string }> {
    try {
      const res = await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: "application/json",
          IfNoneMatch: condition && "ifNoneMatch" in condition ? "*" : undefined,
          IfMatch: condition && "ifMatch" in condition ? condition.ifMatch : undefined,
        }),
      );
      return { etag: res.ETag ?? "" };
    } catch (err) {
      // 412: the precondition failed; 409: a concurrent conditional write is in flight (retryable);
      // 404 on an If-Match write means the object vanished under us.
      const status = statusOf(err);
      if (
        status === 412 ||
        status === 409 ||
        (status === 404 && condition && "ifMatch" in condition)
      )
        throw new PreconditionFailedError(key);
      throw err;
    }
  }

  async putBytes(key: string, body: Uint8Array, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
    );
  }

  async getBytes(key: string): Promise<Uint8Array | null> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return (await res.Body?.transformToByteArray()) ?? new Uint8Array();
    } catch (err) {
      if (nameOf(err) === "NoSuchKey" || statusOf(err) === 404) return null;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      for (const item of res.Contents ?? []) if (item.Key) keys.push(item.Key);
      token = res.NextContinuationToken;
    } while (token);
    return keys;
  }

  async folders(prefix: string): Promise<string[]> {
    const folders: string[] = [];
    let token: string | undefined;
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          Delimiter: "/",
          ContinuationToken: token,
        }),
      );
      for (const item of res.CommonPrefixes ?? []) if (item.Prefix) folders.push(item.Prefix);
      token = res.NextContinuationToken;
    } while (token);
    return folders;
  }
}
