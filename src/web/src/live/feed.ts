import { runEventSchema, type RunEvent, type RunEventsPage, type StreamToken } from "@swarm/shared";

/** The few WebSocket members the feed uses, so tests can supply a fake. */
export interface SocketLike {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

export type Transport = "connecting" | "live" | "polling";

export interface FeedDeps {
  /** Events after `after`, from the API (S3 behind it). */
  getEvents(after: number): Promise<RunEventsPage>;
  getStreamToken(): Promise<StreamToken>;
  createSocket(url: string, protocols: string[]): SocketLike;
  /** Applies events to the run store, in seq order. */
  onEvents(events: RunEvent[]): void;
  /** Highest seq the store has applied. */
  lastSeq(): number;
  onTransport(transport: Transport): void;
  /** The run's `complete` event has been applied. */
  onEnd(): void;
  /** Poll interval while there is no live channel. */
  pollMs?: number;
  /** Catch-up interval while the live channel is up, as a safety net. */
  safetyMs?: number;
  /** How long a gap in the live stream may last before the feed asks the API for the missing events. */
  gapMs?: number;
  /** Reconnect attempts before falling back to polling. */
  reconnects?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
}

const base64Url = (value: string) =>
  btoa(value).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

/**
 * Feeds one run's events to the UI: first everything the API already has (S3 catch-up), then the live
 * channel, with polling as the fallback when there is no channel or it drops. `seq` makes every path
 * idempotent: an event is applied once, in order, whichever route it took.
 */
export class LiveFeed {
  private stopped = false;
  private ended = false;
  private socket: SocketLike | null = null;
  private timers = new Set<unknown>();
  private pending = new Map<number, RunEvent>();
  private catching: Promise<void> | null = null;
  private attempts = 0;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (id: unknown) => void;

  constructor(private readonly deps: FeedDeps) {
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((id) => clearTimeout(id as number));
  }

  async start(): Promise<void> {
    this.deps.onTransport("connecting");
    await this.catchUp();
    if (!this.stopped && !this.ended) void this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.closeSocket();
    for (const timer of this.timers) this.clearTimer(timer);
    this.timers.clear();
  }

  private later(fn: () => void, ms: number) {
    const id = this.setTimer(() => {
      this.timers.delete(id);
      if (!this.stopped) fn();
    }, ms);
    this.timers.add(id);
  }

  /** Reads everything after what is applied, from the API. Concurrent calls share one request. */
  private catchUp(): Promise<void> {
    this.catching ??= (async () => {
      try {
        for (;;) {
          const page = await this.deps.getEvents(this.deps.lastSeq());
          if (this.stopped) return;
          this.apply(page.events, true);
          if (!page.more || page.events.length === 0) return;
        }
      } catch {
        // The next poll or reconnect tries again.
      } finally {
        this.catching = null;
      }
    })();
    return this.catching;
  }

  /**
   * Applies events in order. Catch-up events are authoritative, so a gap in them is a gap in the log
   * and is skipped; live events must be contiguous, otherwise they wait for the missing ones.
   */
  private apply(events: RunEvent[], authoritative: boolean) {
    const sorted = [...events].sort((a, b) => a.seq - b.seq);
    const ready: RunEvent[] = [];
    let last = this.deps.lastSeq();
    const take = (event: RunEvent) => {
      ready.push(event);
      last = event.seq;
    };
    for (const event of sorted) {
      if (event.seq <= last) continue;
      if (authoritative || event.seq === last + 1) take(event);
      else this.pending.set(event.seq, event);
    }
    // Live events that were waiting may now be next in line.
    for (;;) {
      const next = this.pending.get(last + 1);
      if (!next) break;
      this.pending.delete(next.seq);
      take(next);
    }
    for (const seq of this.pending.keys()) if (seq <= last) this.pending.delete(seq);
    if (ready.length > 0) {
      this.deps.onEvents(ready);
      if (ready.some((e) => e.type === "complete")) this.finish();
    }
    if (this.pending.size > 0) this.later(() => void this.catchUp(), this.deps.gapMs ?? 400);
  }

  private finish() {
    this.ended = true;
    this.closeSocket();
    this.deps.onEnd();
  }

  private closeSocket() {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
    try {
      socket.close();
    } catch {
      // Already closed.
    }
  }

  private poll() {
    if (this.stopped || this.ended) return;
    this.deps.onTransport("polling");
    this.later(async () => {
      await this.catchUp();
      this.poll();
    }, this.deps.pollMs ?? 2000);
  }

  private safetyCatchUp() {
    this.later(async () => {
      if (this.socket) await this.catchUp();
      if (this.socket) this.safetyCatchUp();
    }, this.deps.safetyMs ?? 15_000);
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.ended) return;
    let token: StreamToken;
    try {
      token = await this.deps.getStreamToken();
    } catch {
      return this.poll();
    }
    if (this.stopped || this.ended) return;

    const authorization = { host: token.host, Authorization: token.token };
    const socket = this.deps.createSocket(token.realtimeUrl, [
      "aws-appsync-event-ws",
      `header-${base64Url(JSON.stringify(authorization))}`,
    ]);
    this.socket = socket;
    const subscription = `run-${Math.random().toString(36).slice(2, 10)}`;

    const lost = () => {
      if (this.socket !== socket) return;
      this.closeSocket();
      if (this.ended || this.stopped) return;
      if (++this.attempts > (this.deps.reconnects ?? 2)) return this.poll();
      this.later(() => void this.catchUp().then(() => this.connect()), 1000 * this.attempts);
    };

    socket.onopen = () => socket.send(JSON.stringify({ type: "connection_init" }));
    socket.onerror = lost;
    socket.onclose = lost;
    socket.onmessage = ({ data }) => {
      let message: { type?: string; event?: unknown };
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }
      switch (message.type) {
        case "connection_ack":
          socket.send(
            JSON.stringify({
              type: "subscribe",
              id: subscription,
              channel: token.channel,
              authorization,
            }),
          );
          break;
        case "subscribe_success":
          this.attempts = 0;
          this.deps.onTransport("live");
          this.safetyCatchUp();
          // Anything published between the catch-up and the subscription is read now.
          void this.catchUp();
          break;
        case "data": {
          try {
            const parsed = runEventSchema.safeParse(
              typeof message.event === "string" ? JSON.parse(message.event) : message.event,
            );
            if (parsed.success) this.apply([parsed.data], false);
          } catch {
            // Not one of ours.
          }
          break;
        }
        case "subscribe_error":
        case "connection_error":
        case "error":
          lost();
          break;
      }
    };
  }
}
