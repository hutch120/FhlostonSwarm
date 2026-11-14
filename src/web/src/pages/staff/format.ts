import type { EntitlementSource } from "@swarm/shared";

/** Dollars for the staff screens: whole cents for amounts that matter, more places for fractions of a cent. */
export function usd(amount: number | null | undefined): string {
  if (amount === null || amount === undefined) return "…";
  const digits = Math.abs(amount) > 0 && Math.abs(amount) < 0.1 ? 4 : 2;
  return `US$${amount.toFixed(digits)}`;
}

export const percent = (fraction: number, digits = 1) => `${(fraction * 100).toFixed(digits)}%`;

export const SOURCE_LABELS: Record<EntitlementSource, string> = {
  staff: "Staff (no credit)",
  comp: "Complimentary credit",
  purchase: "Purchased credit",
  credit: "Credit (source not recorded)",
};

/** Seconds as `12m 05s`, or `45s`. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  return m === 0 ? `${total}s` : `${m}m ${String(total % 60).padStart(2, "0")}s`;
}

export const today = () => new Date().toISOString().slice(0, 10);

export const daysAgo = (days: number) =>
  new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

/** One host or domain per line, as typed in a textarea. */
export const lines = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((l) => l.trim().toLowerCase())
    .filter(Boolean);
