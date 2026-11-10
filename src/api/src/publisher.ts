import type { RunEvent } from "@swarm/shared";
import {
  environmentCredentials,
  signedFetch,
  type CredentialsProvider,
} from "@swarm/shared/server";

/** Pushes events to whoever is watching a run live. Delivery is best effort: the log in S3 is the record. */
export interface EventPublisher {
  publish(runId: string, events: readonly RunEvent[]): Promise<void>;
}

/**
 * The AppSync Events channel for a run. Channel segments allow letters, digits and hyphens only, so
 * the underscore in the run id becomes a hyphen.
 */
export const channelFor = (runId: string) => `/runs/${runId.replaceAll("_", "-")}`;

/** AppSync Events accepts at most five events per publish call. */
const PER_CALL = 5;

export class AppSyncPublisher implements EventPublisher {
  private readonly send: (input: string, init?: RequestInit) => Promise<Response>;

  constructor(
    private readonly options: {
      /** `<apiId>.appsync-api.<region>.amazonaws.com` */
      httpDomain: string;
      region: string;
      credentials?: CredentialsProvider;
      fetchFn?: (input: string, init?: RequestInit) => Promise<Response>;
    },
  ) {
    this.send = signedFetch({
      service: "appsync",
      region: options.region,
      credentials: options.credentials ?? environmentCredentials(),
      fetchFn: options.fetchFn,
    });
  }

  async publish(runId: string, events: readonly RunEvent[]): Promise<void> {
    for (let i = 0; i < events.length; i += PER_CALL) {
      const slice = events.slice(i, i + PER_CALL);
      try {
        const res = await this.send(`https://${this.options.httpDomain}/event`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            channel: channelFor(runId),
            events: slice.map((e) => JSON.stringify(e)),
          }),
        });
        if (!res.ok) {
          console.error(JSON.stringify({ msg: "publish_failed", status: res.status }));
        }
      } catch (err) {
        console.error(JSON.stringify({ msg: "publish_failed", name: (err as Error).name }));
      }
    }
  }
}

/** For the local dev server and tests with no live channel. */
export class MemoryPublisher implements EventPublisher {
  readonly published: { runId: string; event: RunEvent }[] = [];
  async publish(runId: string, events: readonly RunEvent[]): Promise<void> {
    for (const event of events) this.published.push({ runId, event });
  }
}
