import { replayEvents, type RunEvent, type RunEventsPage, type StreamToken } from "@swarm/shared";
import { describe, expect, it } from "vitest";
import { LiveFeed, type SocketLike, type Transport } from "./feed.js";

class FakeSocket implements SocketLike {
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  sent: Record<string, unknown>[] = [];
  closed = false;
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {}
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
  }
  /** What the server does. */
  open() {
    this.onopen?.({});
  }
  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  publish(event: RunEvent) {
    this.receive({ type: "data", id: "x", event: JSON.stringify(event) });
  }
}

const token: StreamToken = {
  token: "tok.en",
  realtimeUrl: "wss://rt.example/event/realtime",
  host: "http.example",
  channel: "/runs/run_demo0001",
  expiresAt: "2026-11-10T00:00:00.000Z",
};

const upTo = (n: number) => replayEvents.slice(0, n);
const last = replayEvents.at(-1)!;

/** A feed with a hand-turned clock, an API holding `log`, and recorded output. */
function harness(options: { log?: RunEvent[]; streaming?: boolean; reconnects?: number } = {}) {
  const log = options.log ?? [];
  const applied: RunEvent[] = [];
  const transports: Transport[] = [];
  const sockets: FakeSocket[] = [];
  const timers: { id: number; at: number; fn: () => void }[] = [];
  let clock = 0;
  let nextId = 1;
  let ended = 0;
  let apiCalls = 0;

  const feed = new LiveFeed({
    getEvents: async (after): Promise<RunEventsPage> => {
      apiCalls += 1;
      const events = log.filter((e) => e.seq > after).slice(0, 4);
      const lastSeq = events.at(-1)?.seq ?? after;
      return { events, lastSeq, more: log.filter((e) => e.seq > lastSeq).length > 0 };
    },
    getStreamToken: async () => {
      if (options.streaming === false) throw new Error("streaming_unavailable");
      return token;
    },
    createSocket: (url, protocols) => {
      const socket = new FakeSocket(url, protocols);
      sockets.push(socket);
      return socket;
    },
    onEvents: (events) => applied.push(...events),
    lastSeq: () => applied.at(-1)?.seq ?? 0,
    onTransport: (t) => transports.push(t),
    onEnd: () => {
      ended += 1;
    },
    pollMs: 1000,
    safetyMs: 10_000,
    gapMs: 300,
    reconnects: options.reconnects ?? 2,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.push({ id, at: clock + ms, fn });
      return id;
    },
    clearTimer: (id) => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
  });

  /** Moves time forward, running due timers (and letting their async work settle). */
  const advance = async (ms: number) => {
    clock += ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= clock).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers.splice(timers.indexOf(due), 1);
      due.fn();
      for (let i = 0; i < 20; i++) await Promise.resolve();
    }
  };
  const settle = async () => {
    for (let i = 0; i < 40; i++) await Promise.resolve();
  };
  return {
    feed,
    log,
    applied,
    transports,
    sockets,
    advance,
    settle,
    ended: () => ended,
    apiCalls: () => apiCalls,
  };
}

/** Walks a fake socket through the handshake the way AppSync Events does. */
async function handshake(h: ReturnType<typeof harness>, socket: FakeSocket) {
  socket.open();
  socket.receive({ type: "connection_ack", connectionTimeoutMs: 300000 });
  socket.receive({ type: "subscribe_success", id: "x" });
  await h.settle();
}

describe("catch-up", () => {
  it("applies what the API already has, in order, in pages", async () => {
    const h = harness({ log: upTo(10) });
    await h.feed.start();
    expect(h.applied.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    h.feed.stop();
  });

  it("does not open the live channel for a run that has already finished", async () => {
    const h = harness({ log: replayEvents.slice() });
    await h.feed.start();
    expect(h.applied.at(-1)).toEqual(last);
    expect(h.ended()).toBe(1);
    expect(h.sockets).toHaveLength(0);
  });
});

describe("live channel", () => {
  it("connects with the run token, subscribes to the run's channel and applies published events once", async () => {
    const h = harness({ log: upTo(3) });
    await h.feed.start();
    await h.advance(0);
    expect(h.sockets).toHaveLength(1);
    const socket = h.sockets[0]!;
    expect(socket.url).toBe(token.realtimeUrl);
    expect(socket.protocols[0]).toBe("aws-appsync-event-ws");
    const header = socket.protocols[1]!.replace(/^header-/, "");
    expect(JSON.parse(atob(header.replaceAll("-", "+").replaceAll("_", "/")))).toEqual({
      host: token.host,
      Authorization: token.token,
    });

    socket.open();
    expect(socket.sent[0]).toEqual({ type: "connection_init" });
    socket.receive({ type: "connection_ack" });
    expect(socket.sent[1]).toMatchObject({
      type: "subscribe",
      channel: token.channel,
      authorization: { host: token.host, Authorization: token.token },
    });
    socket.receive({ type: "subscribe_success", id: "x" });
    await h.settle();
    expect(h.transports.at(-1)).toBe("live");

    for (const event of replayEvents.slice(3, 6)) socket.publish(event);
    socket.publish(replayEvents[4]!);
    socket.publish(replayEvents[1]!);
    expect(h.applied.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    h.feed.stop();
    expect(socket.closed).toBe(true);
  });

  it("waits for a missing event, then asks the API for it", async () => {
    const h = harness({ log: upTo(2) });
    await h.feed.start();
    await h.advance(0);
    const socket = h.sockets[0]!;
    await handshake(h, socket);
    // Events 3 was lost on the way; 4 arrives first.
    h.log.push(replayEvents[2]!, replayEvents[3]!);
    socket.publish(replayEvents[3]!);
    expect(h.applied.map((e) => e.seq)).toEqual([1, 2]);
    await h.advance(400);
    expect(h.applied.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    h.feed.stop();
  });

  it("ends when the complete event arrives and closes the channel", async () => {
    const h = harness({ log: upTo(replayEvents.length - 1) });
    await h.feed.start();
    await h.advance(0);
    const socket = h.sockets[0]!;
    await handshake(h, socket);
    socket.publish(last);
    expect(h.applied.at(-1)).toEqual(last);
    expect(h.ended()).toBe(1);
    expect(socket.closed).toBe(true);
  });

  it("ignores messages that are not run events", async () => {
    const h = harness({ log: upTo(1) });
    await h.feed.start();
    await h.advance(0);
    const socket = h.sockets[0]!;
    await handshake(h, socket);
    socket.receive({ type: "ka" });
    socket.receive({ type: "data", id: "x", event: "not json" });
    socket.receive({ type: "data", id: "x", event: JSON.stringify({ type: "nope" }) });
    socket.onmessage?.({ data: "garbage" });
    expect(h.applied.map((e) => e.seq)).toEqual([1]);
    h.feed.stop();
  });

  it("reconnects after a drop, catching up first, and gives up for polling after repeated drops", async () => {
    const h = harness({ log: upTo(2), reconnects: 1 });
    await h.feed.start();
    await h.advance(0);
    await handshake(h, h.sockets[0]!);
    h.log.push(replayEvents[2]!);
    h.sockets[0]!.onclose?.({});
    await h.advance(1500);
    expect(h.sockets).toHaveLength(2);
    expect(h.applied.map((e) => e.seq)).toEqual([1, 2, 3]);

    h.sockets[1]!.onerror?.({});
    await h.advance(5000);
    expect(h.transports.at(-1)).toBe("polling");
    h.feed.stop();
  });

  it("falls back to polling when the subscription is refused", async () => {
    const h = harness({ log: upTo(2), reconnects: 0 });
    await h.feed.start();
    await h.advance(0);
    h.sockets[0]!.open();
    h.sockets[0]!.receive({ type: "subscribe_error", errors: [] });
    await h.settle();
    expect(h.transports.at(-1)).toBe("polling");
    h.feed.stop();
  });
});

describe("polling", () => {
  it("polls the API when there is no live channel, and stops at the complete event", async () => {
    const h = harness({ log: upTo(3), streaming: false });
    await h.feed.start();
    await h.advance(0);
    expect(h.transports.at(-1)).toBe("polling");
    expect(h.applied).toHaveLength(3);

    h.log.push(...replayEvents.slice(3, 6));
    await h.advance(1000);
    expect(h.applied.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);

    h.log.push(...replayEvents.slice(6));
    for (let i = 0; i < 40 && h.ended() === 0; i++) await h.advance(1000);
    expect(h.applied.at(-1)).toEqual(last);
    expect(h.ended()).toBe(1);
    const calls = h.apiCalls();
    await h.advance(10_000);
    expect(h.apiCalls()).toBe(calls);
  });

  it("stops polling when the page leaves", async () => {
    const h = harness({ log: upTo(1), streaming: false });
    await h.feed.start();
    await h.advance(0);
    h.feed.stop();
    const calls = h.apiCalls();
    await h.advance(10_000);
    expect(h.apiCalls()).toBe(calls);
  });
});
