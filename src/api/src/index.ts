import { runIdSchema, type RunId } from "@swarm/shared";

export const parseRunId = (value: string): RunId => runIdSchema.parse(value);
