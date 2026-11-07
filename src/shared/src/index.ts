import { z } from "zod";

export const ok = <T>(value: T) => ({ ok: true as const, value });
export const err = <E>(error: E) => ({ ok: false as const, error });

export type Result<T, E = Error> = ReturnType<typeof ok<T>> | ReturnType<typeof err<E>>;

const idSchema = <P extends string>(prefix: P) =>
  z.string().regex(new RegExp(`^${prefix}_[0-9a-z]{8,}$`), `expected ${prefix}_<id>`);

export const runIdSchema = idSchema("run");
export type RunId = z.infer<typeof runIdSchema>;

export const userIdSchema = idSchema("usr");
export type UserId = z.infer<typeof userIdSchema>;

export * from "./events.js";
export * from "./reducer.js";
export * from "./tiers.js";
export { AGENTS, AREAS, DEMO_RUN_ID, DEMO_TARGET } from "./fixtures/roster.js";
export { buildReplayEvents, replayEvents } from "./fixtures/script.js";
