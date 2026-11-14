import { TIER_IDS, tierIdSchema, type TierId } from "@swarm/shared";
import { z } from "zod";
import { updateJson } from "./storage/json.js";
import { keys } from "./storage/keys.js";
import type { ObjectStore } from "./storage/store.js";

const count = z.number().int().nonnegative().default(0);
const tierCounts = z.object(
  Object.fromEntries(TIER_IDS.map((tier) => [tier, count])) as Record<TierId, typeof count>,
);

export const creditSourceSchema = z.enum(["comp", "purchase"]);
export type CreditSource = z.infer<typeof creditSourceSchema>;

const grantSchema = z.object({
  at: z.number(),
  source: creditSourceSchema,
  tier: tierIdSchema,
  count: z.number().int().positive(),
  reason: z.string(),
  by: z.string(),
});
export type Grant = z.infer<typeof grantSchema>;

/** The credit ledger: what was granted per source and depth, and what runs have consumed. */
const ledgerSchema = z.object({
  test: z.boolean().optional(),
  granted: z.object({ comp: tierCounts, purchase: tierCounts }),
  consumed: tierCounts,
  /** Which source each consumed credit came from, so cost analysis can split comp from paid runs. */
  consumedFrom: z
    .object({ comp: tierCounts, purchase: tierCounts })
    .default(() => ({ comp: tierCounts.parse({}), purchase: tierCounts.parse({}) })),
  grants: z.array(grantSchema),
  updatedAt: z.number(),
});
export type Ledger = z.infer<typeof ledgerSchema>;

export type Credits = Record<TierId, number>;

const empty = (now: number, test?: true): Ledger =>
  ledgerSchema.parse({
    ...(test ? { test } : {}),
    granted: { comp: {}, purchase: {} },
    consumed: {},
    grants: [],
    updatedAt: now,
  });

const balance = (ledger: Ledger, tier: TierId) =>
  ledger.granted.comp[tier] + ledger.granted.purchase[tier] - ledger.consumed[tier];

/** Complimentary credits go first, so a purchased credit is never used up while a free one is left. */
const sourceToSpend = (ledger: Ledger, tier: TierId): CreditSource =>
  ledger.granted.comp[tier] - ledger.consumedFrom.comp[tier] > 0 ? "comp" : "purchase";

// Many runs can start at once from one account: allow a long compare-and-swap retry budget.
const RETRIES = 60;

/** The whole ledger, for the staff view of an account. */
export async function getLedger(store: ObjectStore, emailHash: string): Promise<Ledger | null> {
  const found = await store.get(keys.entitlements(emailHash));
  return found ? ledgerSchema.parse(JSON.parse(found.body)) : null;
}

export async function getCredits(store: ObjectStore, emailHash: string): Promise<Credits> {
  const found = await store.get(keys.entitlements(emailHash));
  const ledger = found ? ledgerSchema.parse(JSON.parse(found.body)) : null;
  return Object.fromEntries(
    TIER_IDS.map((tier) => [tier, ledger ? Math.max(0, balance(ledger, tier)) : 0]),
  ) as Credits;
}

export interface GrantRequest {
  tier: TierId;
  count: number;
  source: CreditSource;
  reason: string;
  /** Who granted it: the staff principal. */
  by: string;
}

/** Adds credits to the ledger (creating it if needed) and records the grant in it. */
export async function grantCredits(
  store: ObjectStore,
  emailHash: string,
  request: GrantRequest,
  now: number,
  test?: true,
): Promise<Credits> {
  await updateJson(
    store,
    keys.entitlements(emailHash),
    ledgerSchema,
    (current) => {
      const ledger = current ?? empty(now, test);
      ledger.granted[request.source][request.tier] += request.count;
      ledger.grants.push({ at: now, ...request });
      ledger.updatedAt = now;
      return ledger;
    },
    { retries: RETRIES },
  );
  return getCredits(store, emailHash);
}

/**
 * Takes one credit of the depth if the account has one and returns which source it came from
 * (null when there is none). The compare-and-swap makes concurrent spends serialise: with one
 * credit and fifty callers, exactly one gets a source back.
 */
export async function spendCredit(
  store: ObjectStore,
  emailHash: string,
  tier: TierId,
  now: number,
): Promise<CreditSource | null> {
  let spent: CreditSource | null = null;
  await updateJson(
    store,
    keys.entitlements(emailHash),
    ledgerSchema,
    (current) => {
      spent = null;
      if (!current || balance(current, tier) <= 0) return undefined;
      const source = sourceToSpend(current, tier);
      spent = source;
      return {
        ...current,
        consumed: { ...current.consumed, [tier]: current.consumed[tier] + 1 },
        consumedFrom: {
          ...current.consumedFrom,
          [source]: {
            ...current.consumedFrom[source],
            [tier]: current.consumedFrom[source][tier] + 1,
          },
        },
        updatedAt: now,
      };
    },
    { retries: RETRIES },
  );
  return spent;
}

/** Gives a spent credit back (a run that could not be started) to the source it came from. */
export async function refundCredit(
  store: ObjectStore,
  emailHash: string,
  tier: TierId,
  now: number,
  source?: CreditSource,
): Promise<void> {
  await updateJson(
    store,
    keys.entitlements(emailHash),
    ledgerSchema,
    (current) => {
      if (!current || current.consumed[tier] <= 0) return undefined;
      const from = source && current.consumedFrom[source][tier] > 0 ? source : null;
      return {
        ...current,
        consumed: { ...current.consumed, [tier]: current.consumed[tier] - 1 },
        consumedFrom: from
          ? {
              ...current.consumedFrom,
              [from]: {
                ...current.consumedFrom[from],
                [tier]: current.consumedFrom[from][tier] - 1,
              },
            }
          : current.consumedFrom,
        updatedAt: now,
      };
    },
    { retries: RETRIES },
  );
}
