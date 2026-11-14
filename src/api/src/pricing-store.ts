import { pricing as seedPricing, pricingSchema, type Pricing } from "@swarm/shared/server";
import { z } from "zod";
import { writeAudit } from "./audit.js";
import { createJson, getJson, putJson } from "./storage/json.js";
import { keys } from "./storage/keys.js";
import type { ObjectStore } from "./storage/store.js";

/**
 * The price table behind the staff-only cost estimate, versioned (PLAN.md section 12). The shipped
 * `pricing.json` is the table until staff save one; each saved table is an immutable version, so a
 * run keeps the prices it was costed with, and the pointer says which one new runs use.
 */

const pointerSchema = z.object({ version: z.string(), at: z.number(), by: z.string() });
const versionSchema = z.object({
  savedAt: z.number(),
  by: z.string(),
  note: z.string().max(300),
  table: pricingSchema,
});

export interface PricingVersionInfo {
  version: string;
  savedAt: number | null;
  by: string;
  note: string;
  verified: boolean;
  /** True for the table that ships in `pricing.json` (no saved version). */
  shipped?: boolean;
}

export async function getActivePricing(store: ObjectStore): Promise<Pricing> {
  const pointer = (await getJson(store, keys.pricingCurrent, pointerSchema))?.value;
  if (!pointer) return seedPricing;
  const found = await getJson(store, keys.pricingVersion(pointer.version), versionSchema);
  return found?.value.table ?? seedPricing;
}

export async function getPricingVersion(
  store: ObjectStore,
  version: string,
): Promise<Pricing | null> {
  if (version === seedPricing.version) {
    const saved = await getJson(store, keys.pricingVersion(version), versionSchema);
    return saved?.value.table ?? seedPricing;
  }
  return (await getJson(store, keys.pricingVersion(version), versionSchema))?.value.table ?? null;
}

/** Every saved version, newest first, and the shipped table when nothing saved carries its name. */
export async function listPricingVersions(store: ObjectStore): Promise<PricingVersionInfo[]> {
  const found = await Promise.all(
    (await store.list(keys.pricingVersionsPrefix)).map((key) => getJson(store, key, versionSchema)),
  );
  const saved = found
    .flatMap((f) => (f ? [f.value] : []))
    .map((v): PricingVersionInfo => ({
      version: v.table.version,
      savedAt: v.savedAt,
      by: v.by,
      note: v.note,
      verified: v.table.verified,
    }))
    .sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0));
  return saved.some((v) => v.version === seedPricing.version)
    ? saved
    : [
        ...saved,
        {
          version: seedPricing.version,
          savedAt: null,
          by: "pricing.json",
          note: "The table shipped with the code.",
          verified: seedPricing.verified,
          shipped: true,
        },
      ];
}

/** Saves a table as a new immutable version and makes it the one new runs are costed with. */
export async function savePricing(
  store: ObjectStore,
  table: Pricing,
  note: string,
  by: string,
  now: number,
): Promise<boolean> {
  const checked = pricingSchema.parse(table);
  if (
    !(await createJson(store, keys.pricingVersion(checked.version), {
      savedAt: now,
      by,
      note,
      table: checked,
    }))
  )
    return false;
  await putJson(store, keys.pricingCurrent, { version: checked.version, at: now, by });
  await writeAudit(store, now, { action: "set-pricing", by, version: checked.version, note });
  return true;
}
