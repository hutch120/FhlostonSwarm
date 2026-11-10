/** Fixed names shared between stacks, so stacks can refer to each other's resources without a dependency cycle. */
export const RUN_CLUSTER = "swarm-runs";
export const RUN_STATE_MACHINE = "swarm-run";
export const AGENT_FAMILY = "swarm-agent";
export const SYNTHETIC_TARGET_FAMILY = "swarm-test-synthetic-target";
/** The synthetic target listens here; `swarm synthetic-target start` opens only this port. */
export const SYNTHETIC_TARGET_PORT = 8080;
