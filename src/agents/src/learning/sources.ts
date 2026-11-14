import { createHash } from "node:crypto";
import {
  learningConfig,
  readCachedSource,
  writeCachedSource,
  type CachedSource,
  type LearningConfig,
  type LearningStorage,
  type SourceConfig,
} from "@swarm/shared/server";

/**
 * The allow-listed sources the learning pass reads (PLAN.md section 9): OWASP, CISA KEV and similar.
 * Each is fetched at most once per refresh interval and cached. A fetch is limited in size and
 * time, must answer over https with a text content type and stay on a listed host, and is reduced
 * to plain text. What comes back is untrusted data: the learner reads it inside delimiters and it
 * can never choose a host, tool or limit.
 */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const TEXT_TYPES = /^(text\/(html|plain|xml)|application\/(json|xml|xhtml\+xml))/i;
const FETCH_TIMEOUT_MS = 12_000;

export interface LoadedSource {
  id: string;
  name: string;
  url: string;
  /** When the text was fetched (ISO). */
  fetchedAt: string;
  hash: string;
  text: string;
  /** False when the cache was used because a fetch failed or was not due. */
  fresh: boolean;
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&nbsp;": " ",
};

/** A page as plain text: scripts, styles and markup removed, entities decoded, whitespace collapsed. */
export function htmlToText(html: string): string {
  return html
    .replaceAll(/<(script|style|noscript|svg|nav|footer)\b[\s\S]*?<\/\1>/gi, " ")
    .replaceAll(/<!--[\s\S]*?-->/g, " ")
    .replaceAll(/<[^>]+>/g, " ")
    .replaceAll(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m] ?? " ")
    .replaceAll(/\s+/g, " ")
    .trim();
}

/** The newest entries of the CISA catalogue, one line each. */
export function kevToText(json: string, limit = 25): string {
  const data = JSON.parse(json) as {
    vulnerabilities?: {
      cveID?: string;
      vendorProject?: string;
      product?: string;
      vulnerabilityName?: string;
      dateAdded?: string;
    }[];
  };
  return (data.vulnerabilities ?? [])
    .toSorted((a, b) => (b.dateAdded ?? "").localeCompare(a.dateAdded ?? ""))
    .slice(0, limit)
    .map(
      (v) =>
        `${v.cveID ?? "?"} ${v.vendorProject ?? ""} ${v.product ?? ""}: ${v.vulnerabilityName ?? ""} (added ${v.dateAdded ?? "?"})`,
    )
    .join("\n");
}

async function readLimited(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return (await res.text()).slice(0, maxBytes);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error("the source is larger than its limit");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function download(
  source: SourceConfig,
  hosts: ReadonlySet<string>,
  fetchFn: FetchLike,
  signal: AbortSignal | undefined,
): Promise<string> {
  const res = await fetchFn(source.url, {
    redirect: "follow",
    headers: { accept: "text/html,application/json;q=0.9", "user-agent": "SwarmLearner/0.1" },
    signal: AbortSignal.any([AbortSignal.timeout(FETCH_TIMEOUT_MS), ...(signal ? [signal] : [])]),
  });
  if (!res.ok) throw new Error(`answered ${res.status}`);
  const finalUrl = new URL(res.url || source.url);
  if (finalUrl.protocol !== "https:" || !hosts.has(finalUrl.hostname)) {
    throw new Error("redirected away from the listed hosts");
  }
  const type = res.headers.get("content-type") ?? "";
  if (!TEXT_TYPES.test(type)) throw new Error("not a text content type");
  const raw = await readLimited(res, source.maxBytes);
  return source.kind === "cisa-kev" ? kevToText(raw) : htmlToText(raw);
}

/**
 * Every source's text, from the cache when it is not due for a refresh. A source that cannot be
 * fetched falls back to its cache, or is left out; one failing source never stops the pass.
 */
export async function loadSources(options: {
  storage: LearningStorage;
  root: string;
  fetch: FetchLike;
  now: Date;
  config?: LearningConfig;
  signal?: AbortSignal;
  /** Fetch even when the cache is fresh. */
  force?: boolean;
}): Promise<{ sources: LoadedSource[]; problems: string[] }> {
  const config = options.config ?? learningConfig;
  const hosts = new Set(config.sources.map((s) => new URL(s.url).hostname));
  const problems: string[] = [];
  const sources = await Promise.all(
    config.sources.map(async (source): Promise<LoadedSource | null> => {
      const cached = await readCachedSource(options.storage, options.root, source.id);
      const ageHours = cached
        ? (options.now.getTime() - Date.parse(cached.fetchedAt)) / 3_600_000
        : Infinity;
      const view = (c: CachedSource, fresh: boolean): LoadedSource => ({
        id: source.id,
        name: source.name,
        url: source.url,
        fetchedAt: c.fetchedAt,
        hash: c.hash,
        text: c.text,
        fresh,
      });
      if (cached && ageHours < source.refreshHours && !options.force) return view(cached, false);
      try {
        const text = await download(source, hosts, options.fetch, options.signal);
        const next: CachedSource = {
          id: source.id,
          url: source.url,
          fetchedAt: options.now.toISOString(),
          hash: sha(text),
          text,
        };
        await writeCachedSource(options.storage, options.root, next);
        return view(next, true);
      } catch (err) {
        problems.push(`${source.id}: ${(err as Error).message}`);
        return cached ? view(cached, false) : null;
      }
    }),
  );
  return { sources: sources.filter((s): s is LoadedSource => s !== null), problems };
}
