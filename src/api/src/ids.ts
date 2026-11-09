import { randomBytes } from "node:crypto";

/** `<prefix>_<time><random>`, lowercase base 36 and hex so it matches the id schemas in @swarm/shared. */
export const newId = (prefix: "tgt" | "scan" | "run", now: number): string =>
  `${prefix}_${now.toString(36).padStart(9, "0")}${randomBytes(6).toString("hex")}`;
