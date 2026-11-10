import type { EventBatch } from "@swarm/shared";
import {
  agentInputSchema,
  containerCredentials,
  signedFetch,
  type AgentInput,
  type ProxyLogEntry,
  type ProxyStats,
} from "@swarm/shared/server";
import type { EventSink } from "./emitter.js";

/** Who the task is and how it proves it: set by the orchestrator in the container environment. */
export interface TaskIdentity {
  apiBase: string;
  region: string;
  owner: string;
  runId: string;
  token: string;
}

export function identityFromEnv(env: NodeJS.ProcessEnv = process.env): TaskIdentity {
  const need = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`${name} is not set`);
    return value;
  };
  return {
    apiBase: need("SWARM_API_BASE").replace(/\/$/, ""),
    region: env["AWS_REGION"] ?? env["AWS_DEFAULT_REGION"] ?? "ap-southeast-2",
    owner: need("SWARM_OWNER"),
    runId: need("SWARM_RUN_ID"),
    token: need("SWARM_RUN_TOKEN"),
  };
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * The agent task's link back to the platform: IAM-signed (the task role) and bound to one run by the
 * run token. The task role has no other permission: it cannot read or write S3 or any other run.
 */
export class InternalApi implements EventSink {
  private readonly fetchFn: FetchLike;

  constructor(
    private readonly identity: TaskIdentity,
    fetchFn?: FetchLike,
  ) {
    this.fetchFn =
      fetchFn ??
      signedFetch({
        service: "execute-api",
        region: identity.region,
        credentials: containerCredentials(),
      });
  }

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await this.fetchFn(`${this.identity.apiBase}/api/internal${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-swarm-owner": this.identity.owner,
        "x-swarm-run": this.identity.runId,
        "x-swarm-token": this.identity.token,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${method} ${path} failed: ${res.status}`);
    return res.json();
  }

  async getInput(): Promise<AgentInput> {
    return agentInputSchema.parse(await this.call("GET", "/input"));
  }

  async send(batch: EventBatch): Promise<void> {
    await this.call("POST", "/events", batch);
  }

  async postEvidence(
    name: "proxy-log" | "proxy-stats",
    body: { entries: ProxyLogEntry[]; dropped: number } | ProxyStats,
  ): Promise<void> {
    await this.call("POST", "/evidence", { name, body });
  }
}
