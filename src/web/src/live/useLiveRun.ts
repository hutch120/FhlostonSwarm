import type { TierId } from "@swarm/shared";
import { useEffect, useState } from "react";
import { api } from "../api/client.js";
import { useRunStore } from "../state/run.js";
import { LiveFeed, type SocketLike, type Transport } from "./feed.js";

export interface LiveRunStatus {
  transport: Transport;
  ended: boolean;
}

/**
 * Feeds the run store from the real event stream for one run: catch-up from the API, then the live
 * channel, polling when there is none. The store is reset for this run first, so screens read the
 * same `useRunStore` the demo replay feeds. Mount it with `key={runId}` so its status starts fresh.
 */
export function useLiveRun(runId: string, tier: TierId, enabled = true): LiveRunStatus {
  const [status, setStatus] = useState<LiveRunStatus>({ transport: "connecting", ended: false });

  useEffect(() => {
    if (!enabled) return;
    const { apply, reset } = useRunStore.getState();
    reset({ runId, tier });

    const feed = new LiveFeed({
      getEvents: (after) => api.getRunEvents(runId, after),
      getStreamToken: () => api.getStreamToken(runId),
      createSocket: (url, protocols) => new WebSocket(url, protocols) as unknown as SocketLike,
      onEvents: (events) => {
        for (const event of events) apply(event);
      },
      lastSeq: () => useRunStore.getState().state.lastSeq,
      onTransport: (transport) => setStatus((s) => (s.ended ? s : { ...s, transport })),
      onEnd: () => setStatus((s) => ({ ...s, ended: true })),
    });
    void feed.start();
    return () => feed.stop();
  }, [runId, tier, enabled]);

  return status;
}
