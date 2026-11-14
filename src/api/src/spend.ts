import { z } from "zod";
import type { Mailer } from "./mailer.js";
import { effectiveSettings } from "./settings.js";
import { getJson, updateJson } from "./storage/json.js";
import { keys } from "./storage/keys.js";
import type { ObjectStore } from "./storage/store.js";

/**
 * The day's spend so far (UTC), kept as one small object per day so the global daily spend alarm
 * needs no scan of the run index. Each closed run adds its estimated cost; the first time the day
 * passes the alarm in the controls, staff are told once (a log line the alarm filter can match, and
 * mail to the support address).
 */
const spendSchema = z.object({
  day: z.string(),
  usd: z.number().nonnegative(),
  runs: z.number().int().nonnegative(),
  /** When the alarm for this day was raised; absent while the day is under the alarm. */
  alarmedAt: z.number().optional(),
});
export type DailySpend = z.infer<typeof spendSchema>;

export const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export interface SpendDeps {
  store: ObjectStore;
  mailer?: Mailer;
  /** Where the alarm is mailed. */
  alertTo?: string;
}

export async function getSpend(store: ObjectStore, day: string): Promise<DailySpend | null> {
  return (await getJson(store, keys.spend(day), spendSchema))?.value ?? null;
}

/** Adds cost to the day (and a run to its count), and raises the alarm the first time the day passes it. */
export async function addSpend(
  deps: SpendDeps,
  at: number,
  usd: number,
  options: { run?: boolean } = {},
): Promise<DailySpend> {
  const { store } = deps;
  const day = dayOf(at);
  const alarmUsd = (await effectiveSettings(store)).dailySpendAlarmUsd;
  let raised = false;
  const next = (await updateJson(store, keys.spend(day), spendSchema, (current) => {
    raised = false;
    const total = (current?.usd ?? 0) + usd;
    const base: DailySpend = {
      day,
      usd: Math.round(total * 1e6) / 1e6,
      runs: (current?.runs ?? 0) + (options.run ? 1 : 0),
      ...(current?.alarmedAt ? { alarmedAt: current.alarmedAt } : {}),
    };
    if (alarmUsd !== null && total >= alarmUsd && !base.alarmedAt) {
      raised = true;
      base.alarmedAt = at;
    }
    return base;
  }))!;
  if (raised && alarmUsd !== null) {
    console.error(
      JSON.stringify({ msg: "spend_alarm", day, usd: next.usd, alarmUsd, runs: next.runs }),
    );
    if (deps.mailer && deps.alertTo) {
      try {
        await deps.mailer.sendStaffAlert({
          to: deps.alertTo,
          subject: `Swarm daily spend alarm: US$${next.usd.toFixed(2)} on ${day}`,
          text: `The runs that closed on ${day} (UTC) cost an estimated US$${next.usd.toFixed(2)} so far, over the alarm of US$${alarmUsd.toFixed(2)}. ${next.runs} runs. Review the staff dashboard, and use the kill switch if this is not expected.`,
        });
      } catch (err) {
        console.error(JSON.stringify({ msg: "mail_failed", name: (err as Error).name }));
      }
    }
  }
  return next;
}
