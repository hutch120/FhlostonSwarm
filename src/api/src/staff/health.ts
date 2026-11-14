import {
  CloudWatchClient,
  GetMetricStatisticsCommand,
  type Statistic,
} from "@aws-sdk/client-cloudwatch";
import { TIER_IDS, type StaffHealth, type TierId } from "@swarm/shared";
import { poolSchema, poolTimes } from "../pool.js";
import { effectiveSettings } from "../settings.js";
import { dayOf, getSpend } from "../spend.js";
import { getJson } from "../storage/json.js";
import { keys } from "../storage/keys.js";
import type { ObjectStore } from "../storage/store.js";
import { recentRuns } from "./runs.js";

/** Reads one CloudWatch metric; null when it has no data or cannot be read. */
export interface MetricsReader {
  read(query: {
    namespace: string;
    metric: string;
    dimensions?: Record<string, string>;
    statistic: "Sum" | "Maximum";
    hours: number;
  }): Promise<number | null>;
}

export class CloudWatchMetrics implements MetricsReader {
  constructor(private readonly client = new CloudWatchClient({})) {}

  async read(query: Parameters<MetricsReader["read"]>[0]): Promise<number | null> {
    try {
      const end = new Date();
      const res = await this.client.send(
        new GetMetricStatisticsCommand({
          Namespace: query.namespace,
          MetricName: query.metric,
          Dimensions: Object.entries(query.dimensions ?? {}).map(([Name, Value]) => ({
            Name,
            Value,
          })),
          StartTime: new Date(end.getTime() - query.hours * 3_600_000),
          EndTime: end,
          Period: query.hours * 3600,
          Statistics: [query.statistic as Statistic],
        }),
      );
      const points = res.Datapoints ?? [];
      if (points.length === 0) return null;
      const values = points.map((p) => (query.statistic === "Sum" ? p.Sum : p.Maximum) ?? 0);
      return query.statistic === "Sum" ? values.reduce((a, b) => a + b, 0) : Math.max(...values);
    } catch (err) {
      console.error(JSON.stringify({ msg: "metrics_failed", name: (err as Error).name }));
      return null;
    }
  }
}

const HOURS = 24;
const QUEUED_STUCK_MINUTES = 60;

/** Which runs hold or wait for a slot in each depth's pool (test accounts have their own pool, counted too). */
async function poolView(store: ObjectStore, limits: Record<TierId, number>) {
  const out = {} as StaffHealth["pools"];
  for (const tier of TIER_IDS) {
    let active = 0;
    let waiting = 0;
    for (const test of [false, true]) {
      const pool = (await getJson(store, keys.pool(tier, test), poolSchema))?.value;
      active += Object.keys(pool?.active ?? {}).length;
      waiting += Object.keys(pool?.waiting ?? {}).length;
    }
    out[tier] = { active, waiting, limit: limits[tier] };
  }
  return out;
}

export async function health(
  store: ObjectStore,
  metrics: MetricsReader | null,
  modelIds: readonly string[],
  now: number,
): Promise<StaffHealth> {
  const settings = await effectiveSettings(store);
  const day = dayOf(now);
  const spend = await getSpend(store, day);

  const stuckRuns = (await recentRuns(store, now, 48 * 3_600_000))
    .filter(({ file }) => {
      const age = now - Date.parse(file.startedAt);
      if (file.status === "running") return age > poolTimes(file.tier).staleMs;
      return file.status === "queued" && age > QUEUED_STUCK_MINUTES * 60_000;
    })
    .map(({ file }) => ({
      runId: file.runId,
      tier: file.tier,
      status: file.status,
      startedAt: file.startedAt,
      ageMinutes: Math.round((now - Date.parse(file.startedAt)) / 60_000),
    }));

  let ses: StaffHealth["ses"] = null;
  let bedrock: StaffHealth["bedrock"] = null;
  if (metrics) {
    const ses24 = (metric: string, statistic: "Sum" | "Maximum" = "Sum") =>
      metrics.read({ namespace: "AWS/SES", metric, statistic, hours: HOURS });
    const [sends, bounces, complaints, bounceRate, complaintRate] = await Promise.all([
      ses24("Send"),
      ses24("Bounce"),
      ses24("Complaint"),
      ses24("Reputation.BounceRate", "Maximum"),
      ses24("Reputation.ComplaintRate", "Maximum"),
    ]);
    if ([sends, bounces, complaints, bounceRate, complaintRate].some((v) => v !== null)) {
      const s = sends ?? 0;
      ses = {
        sends: s,
        bounces: bounces ?? 0,
        complaints: complaints ?? 0,
        bounceRate: s > 0 ? (bounces ?? 0) / s : 0,
        complaintRate: s > 0 ? (complaints ?? 0) / s : 0,
        reputationBounceRate: bounceRate,
        reputationComplaintRate: complaintRate,
      };
    }
    const throttles = await Promise.all(
      modelIds.map((modelId) =>
        metrics.read({
          namespace: "AWS/Bedrock",
          metric: "InvocationThrottles",
          dimensions: { ModelId: modelId },
          statistic: "Sum",
          hours: HOURS,
        }),
      ),
    );
    bedrock = {
      throttles: throttles.reduce<number>((a, b) => a + (b ?? 0), 0),
      modelIds: [...modelIds],
    };
  }

  return {
    at: new Date(now).toISOString(),
    killSwitchOn: settings.killSwitch.on,
    spendToday: {
      day,
      usd: spend?.usd ?? 0,
      runs: spend?.runs ?? 0,
      alarmUsd: settings.dailySpendAlarmUsd,
      alarmed: spend?.alarmedAt !== undefined,
    },
    pools: await poolView(store, settings.concurrency),
    stuckRuns,
    ses,
    bedrock,
    suppressed: (await store.list("suppression/")).length,
  };
}

/** The Bedrock models the depths use (and the learner), for the throttle metric. */
export const configuredModelIds = (limits: Record<TierId, { modelId: string }>): string[] => [
  ...new Set(Object.values(limits).map((l) => l.modelId)),
];
