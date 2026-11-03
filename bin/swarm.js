#!/usr/bin/env node
// Launcher so `swarm` works from any directory after `npm link`, without a global tsx.
import { register } from "tsx/esm/api";

register();
await import("../swarm.ts");
