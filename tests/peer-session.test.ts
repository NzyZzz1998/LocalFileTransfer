import { describe, expect, test } from "bun:test";
import { PeerSession } from "../src/web/peer-session.js";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  sent: string[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.readyState = 1;
    this.onopen?.();
  }

  receive(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  send(payload: string) {
    this.sent.push(payload);
  }

  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

class FakeDataChannel {
  binaryType = "blob";
  readyState = "connecting";
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(
    public label: string,
    public options: { ordered?: boolean },
  ) {}

  close() {
    this.readyState = "closed";
    this.onclose?.();
  }
}

class FakePeerConnection {
  static instances: FakePeerConnection[] = [];
  static candidateType: string | undefined = "host";
  localDescription: unknown = null;
  remoteDescription: unknown = null;
  onicecandidate: ((event: { candidate: unknown }) => void) | null = null;
  ondatachannel: ((event: { channel: FakeDataChannel }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  connectionState = "new";
  iceConnectionState = "new";
  channel: FakeDataChannel | null = null;
  candidates: unknown[] = [];

  constructor(public configuration: unknown) {
    FakePeerConnection.instances.push(this);
  }

  createDataChannel(label: string, options: { ordered?: boolean }) {
    this.channel = new FakeDataChannel(label, options);
    return this.channel;
  }

  async createOffer() {
    return { type: "offer", sdp: "sender-sdp" };
  }

  async createAnswer() {
    return { type: "answer", sdp: "receiver-sdp" };
  }

  async setLocalDescription(description: unknown) {
    this.localDescription = description;
  }

  async setRemoteDescription(description: unknown) {
    this.remoteDescription = description;
  }

  async addIceCandidate(candidate: unknown) {
    this.candidates.push(candidate);
  }

  async getStats() {
    return new Map([
      [
        "transport-1",
        { type: "transport", selectedCandidatePairId: "pair-1" },
      ],
      [
        "pair-1",
        {
          type: "candidate-pair",
          localCandidateId: "local-1",
          remoteCandidateId: "remote-1",
        },
      ],
      ["local-1", { type: "local-candidate", candidateType: FakePeerConnection.candidateType }],
      ["remote-1", { type: "remote-candidate", candidateType: FakePeerConnection.candidateType }],
    ]);
  }

  close() {
    this.connectionState = "closed";
    this.onconnectionstatechange?.();
  }
}

async function createDirectFixture(PeerImpl = FakePeerConnection, joined = true) {
  FakeWebSocket.instances = [];
  FakePeerConnection.instances = [];
  FakePeerConnection.candidateType = "host";
  const events: any[] = [];
  const timers = new Map<number, () => void>();
  let clock = 1_000;
  let heartbeat: (() => void) | undefined;
  const session = new PeerSession({
    WebSocketImpl: FakeWebSocket,
    RTCPeerConnectionImpl: PeerImpl,
    location: { protocol: "http:", host: "dukou.local" },
    onEvent: (event: unknown) => events.push(event),
    now: () => clock,
    setTimeoutImpl: (callback: () => void, delay: number) => {
      timers.set(delay, () => { timers.delete(delay); callback(); });
      return delay;
    },
    clearTimeoutImpl: (token: number) => timers.delete(token),
    setIntervalImpl: (callback: () => void) => { heartbeat = callback; return 1; },
    clearIntervalImpl: () => { heartbeat = undefined; },
  });
  const connected = session.connect();
  const socket = FakeWebSocket.instances[0];
  socket.open();
  await connected;
  if (joined) socket.receive({ type: "peer_joined", role: "sender" });
  // Let the real PeerSession's promise chain settle; only browser I/O is doubled.
  await new Promise((resolve) => setTimeout(resolve, 0));
  return {
    session, socket, events, timers,
    peer: FakePeerConnection.instances[0],
    advance: (ms: number) => { clock += ms; },
    heartbeat: () => heartbeat?.(),
  };
}

describe("PeerSession direct failure isolation", () => {
  test.each(["relay", "unknown", undefined])("unsafe %s path fails before RTC closes while relay signaling and heartbeat remain usable", async (candidateType) => {
    const { session, socket, peer, events, timers, advance, heartbeat } = await createDirectFixture();
    FakePeerConnection.candidateType = candidateType;
    const eventsAtClose: any[] = [];
    const originalClose = peer.channel!.close.bind(peer.channel);
    peer.channel!.close = () => { eventsAtClose.push(...events); originalClose(); };
    advance(275);
    peer.channel!.onopen?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events.filter((event) => event.type === "direct_failed")).toEqual([{
      type: "direct_failed", code: "DIRECT_UNSAFE_ROUTE", reason: "candidate_type_not_direct",
      elapsedMs: 275, localCandidateType: candidateType ?? "unknown", remoteCandidateType: candidateType ?? "unknown",
    }]);
    expect(eventsAtClose.some((event) => event.type === "direct_failed")).toBe(true);
    expect(peer.channel!.readyState).toBe("closed");
    expect(peer.connectionState).toBe("closed");
    expect(timers.size).toBe(0);
    expect(socket.readyState).toBe(1);
    session.requestRelay();
    heartbeat();
    expect(socket.sent.slice(-2).map((message) => JSON.parse(message))).toEqual([
      { type: "request_relay" }, { type: "ping", nonce: "hb-1" },
    ]);
    session.leave();
    FakePeerConnection.candidateType = "host";
  });

  test.each(["rejection", "missing_pair"])("stats %s closes RTC and reports one recoverable failure", async (mode) => {
    const { session, socket, peer, events, timers } = await createDirectFixture();
    peer.getStats = async () => { if (mode === "rejection") throw new Error("stats denied"); return new Map(); };
    peer.channel!.onopen?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events.filter((event) => event.type === "direct_failed")).toHaveLength(1);
    expect(events.find((event) => event.type === "direct_failed")).toMatchObject({
      code: "DIRECT_STATS_UNAVAILABLE",
      reason: mode === "rejection" ? "stats_unavailable" : "selected_pair_unavailable",
    });
    expect(peer.channel!.readyState).toBe("closed");
    expect(timers.size).toBe(0);
    session.requestRelay();
    expect(socket.sent.at(-1)).toBe(JSON.stringify({ type: "request_relay" }));
    session.leave();
  });

  test.each(["failed", "closed", "channel_closed", "channel_error"])("%s has one direct failure without leaving the room", async (state) => {
    const { session, socket, peer, events, timers } = await createDirectFixture();
    if (state === "channel_closed") peer.channel!.close();
    else if (state === "channel_error") peer.channel!.onerror?.();
    else { peer.connectionState = state; peer.onconnectionstatechange?.(); }
    expect(events.filter((event) => event.type === "direct_failed")).toHaveLength(1);
    expect(events.filter((event) => event.type === "signaling" && event.state === "offline")).toEqual([]);
    expect(timers.size).toBe(0);
    expect(socket.readyState).toBe(1);
    session.requestRelay();
    expect(socket.sent.at(-1)).toBe(JSON.stringify({ type: "request_relay" }));
    session.leave();
  });

  test("negotiation rejection preserves the room and reports its own failure", async () => {
    class RejectedOfferPeer extends FakePeerConnection {
      async createOffer(): Promise<{ type: string; sdp: string }> { throw new Error("offer rejected"); }
    }
    const { session, socket, peer, events, timers } = await createDirectFixture(RejectedOfferPeer);
    expect(events.filter((event) => event.type === "direct_failed")).toEqual([
      { type: "direct_failed", code: "RTC_NEGOTIATION_FAILED", reason: "negotiation_failed", elapsedMs: 0 },
    ]);
    expect(peer.connectionState).toBe("closed");
    expect(timers.size).toBe(0);
    session.requestRelay();
    expect(socket.sent.at(-1)).toBe(JSON.stringify({ type: "request_relay" }));
    session.leave();
  });

  test("a hung stats check still times out and late stats cannot certify the failed channel", async () => {
    const { session, peer, events, timers, advance } = await createDirectFixture();
    const goodStats = await peer.getStats();
    let finishStats!: (value: typeof goodStats) => void;
    peer.getStats = () => new Promise((resolve) => { finishStats = resolve; });
    peer.channel!.onopen?.();
    advance(20_000);
    timers.get(20_000)?.();
    expect(events.filter((event) => event.type === "direct_failed")).toEqual([
      { type: "direct_failed", code: "DIRECT_TIMEOUT", reason: "connection_timeout", elapsedMs: 20_000 },
    ]);
    finishStats(goodStats);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events.filter((event) => event.type === "direct_path" && event.direct)).toEqual([]);
    expect(timers.size).toBe(0);
    session.leave();
  });

  test("closeDirect cancels pending negotiation and late signals without leaving the room", async () => {
    let finishOffer!: (offer: { type: string; sdp: string }) => void;
    class DeferredOfferPeer extends FakePeerConnection {
      async createOffer() { return new Promise<{ type: string; sdp: string }>((resolve) => { finishOffer = resolve; }); }
    }
    const { session, socket, peer, events, timers } = await createDirectFixture(DeferredOfferPeer);
    const lateIce = peer.onicecandidate!;
    const lateOpen = peer.channel!.onopen!;
    session.closeDirect();
    session.closeDirect();
    finishOffer({ type: "offer", sdp: "stale-offer" });
    lateIce({ candidate: { candidate: "stale-candidate" } });
    lateOpen();
    socket.receive({ type: "signal", signal: { type: "answer", sdp: "stale-answer" } });
    socket.receive({ type: "signal", signal: { type: "candidate", candidate: "stale-remote-candidate" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(peer.localDescription).toBeNull();
    expect(peer.remoteDescription).toBeNull();
    expect(peer.candidates).toEqual([]);
    expect(socket.sent).toEqual([]);
    expect(events.filter((event) => ["direct_failed", "direct_path", "data_channel"].includes(event.type))).toEqual([]);
    expect(session.peer).toBeNull();
    expect(session.channel).toBeNull();
    expect(timers.size).toBe(0);
    session.requestRelay();
    expect(socket.sent.at(-1)).toBe(JSON.stringify({ type: "request_relay" }));
    session.leave();
  });

  test("a transient disconnected event does not tear down an established direct transfer", async () => {
    const { session, peer, events } = await createDirectFixture();
    peer.channel!.readyState = "open";
    peer.channel!.onopen?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    peer.connectionState = "disconnected";
    peer.onconnectionstatechange?.();
    expect(events).toContainEqual({ type: "peer_connection", state: "disconnected" });
    expect(events.filter((event) => event.type === "direct_failed")).toEqual([]);
    expect(peer.channel!.readyState).toBe("open");
    session.leave();
  });

  test("failure while an offer is pending blocks its later resolution and remote answer", async () => {
    let finishOffer!: (offer: { type: string; sdp: string }) => void;
    class DeferredOfferPeer extends FakePeerConnection {
      async createOffer() { return new Promise<{ type: string; sdp: string }>((resolve) => { finishOffer = resolve; }); }
    }
    const { session, socket, peer, events } = await createDirectFixture(DeferredOfferPeer);
    const lateClose = peer.channel!.onclose!;
    peer.connectionState = "failed";
    peer.onconnectionstatechange?.();
    finishOffer({ type: "offer", sdp: "late-offer" });
    socket.receive({ type: "signal", signal: { type: "answer", sdp: "late-answer" } });
    lateClose();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(peer.localDescription).toBeNull();
    expect(peer.remoteDescription).toBeNull();
    expect(socket.sent).toEqual([]);
    expect(events.filter((event) => event.type === "direct_failed")).toHaveLength(1);
    session.leave();
  });

  test("remote-description rejection uses the same direct failure boundary", async () => {
    const { session, socket, peer, events } = await createDirectFixture();
    peer.setRemoteDescription = async () => { throw new Error("remote description rejected"); };
    socket.receive({ type: "signal", signal: { type: "answer", sdp: "answer" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(events.filter((event) => event.type === "direct_failed")).toEqual([
      { type: "direct_failed", code: "RTC_NEGOTIATION_FAILED", reason: "negotiation_failed", elapsedMs: 0 },
    ]);
    expect(peer.connectionState).toBe("closed");
    expect(socket.readyState).toBe(1);
    session.leave();
  });

  test("late offer rejection from a retired attempt cannot fail its successor", async () => {
    let rejectOffer!: (failure: Error) => void;
    class DeferredOfferPeer extends FakePeerConnection {
      async createOffer() { return new Promise<{ type: string; sdp: string }>((_resolve, reject) => { rejectOffer = reject; }); }
    }
    const { session, events } = await createDirectFixture(DeferredOfferPeer);
    await session.startPeer("receiver");
    const nextPeer = FakePeerConnection.instances.at(-1)!;
    rejectOffer(new Error("old negotiation rejected"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(nextPeer.connectionState).toBe("new");
    expect(session.peer).toBe(nextPeer);
    expect(events.filter((event) => event.type === "direct_failed")).toEqual([]);
    session.leave();
  });

  test("already queued deadline callbacks cannot fail a verified direct route", async () => {
    const { session, peer, events, timers, advance } = await createDirectFixture();
    const lateSlow = timers.get(8_000)!;
    const lateTimeout = timers.get(20_000)!;
    peer.channel!.readyState = "open";
    peer.channel!.onopen?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    advance(20_000);
    lateSlow();
    lateTimeout();
    expect(events.filter((event) => ["direct_failed", "direct_connection"].includes(event.type))).toEqual([]);
    expect(peer.channel!.readyState).toBe("open");
    session.leave();
  });
});

describe("PeerSession diagnostic contract", () => {
  test("reports real phase order and separately measures stage and total elapsed time", async () => {
    const { session, peer, events, advance } = await createDirectFixture();
    expect(events.filter((event) => event.type === "phase").map((event) => event.stage)).toEqual([
      "connecting_signal", "waiting_peer", "finding_route",
    ]);
    advance(420);
    expect(session.getDiagnosticSnapshot()).toMatchObject({
      stage: "finding_route", elapsedMs: 420, totalElapsedMs: 420,
      signalingState: "open", iceState: "new", connectionState: "new", errorCode: null,
    });
    const originalStats = peer.getStats.bind(peer);
    let finishStats!: (stats: Awaited<ReturnType<typeof originalStats>>) => void;
    peer.getStats = () => new Promise((resolve) => { finishStats = resolve; });
    peer.channel!.readyState = "open";
    peer.channel!.onopen?.();
    advance(80);
    expect(session.getDiagnosticSnapshot()).toMatchObject({ stage: "verifying_channel", elapsedMs: 80, totalElapsedMs: 500 });
    finishStats(await originalStats());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.getDiagnosticSnapshot()).toMatchObject({
      stage: "ready", elapsedMs: 0, totalElapsedMs: 500,
      localCandidateType: "host", remoteCandidateType: "host", errorCode: null,
    });
    session.leave();
  });

  test("freezes pre-cleanup failure state and failed-stage time without exposing raw diagnostics", async () => {
    const { session, peer, advance } = await createDirectFixture();
    advance(410);
    peer.connectionState = "connecting";
    peer.iceConnectionState = "checking";
    peer.oniceconnectionstatechange?.();
    peer.getStats = async () => new Map([
      ["transport", { type: "transport", selectedCandidatePairId: "pair" }],
      ["pair", { type: "candidate-pair", localCandidateId: "private-ip", remoteCandidateId: "file-secret" }],
      ["private-ip", { candidateType: "192.168.8.90/secret", address: "192.168.8.90" }],
      ["file-secret", { candidateType: "relay", url: "turn:secret.example", usernameFragment: "583204" }],
    ]) as any;
    peer.channel!.onopen?.();
    advance(65);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const beforeLeave = session.getDiagnosticSnapshot();
    expect(beforeLeave).toEqual({
      stage: "direct_failed", failedStage: "verifying_channel", elapsedMs: 65, totalElapsedMs: 475,
      signalingState: "open", iceState: "checking", connectionState: "connecting",
      localCandidateType: "unknown", remoteCandidateType: "relay", errorCode: "DIRECT_UNSAFE_ROUTE",
    });
    session.leave();
    advance(10_000);
    expect(session.getDiagnosticSnapshot()).toEqual(beforeLeave);
    expect(JSON.stringify(beforeLeave)).not.toMatch(/192\.168|secret|583204|turn:/);
    beforeLeave.errorCode = "mutated";
    expect(session.getDiagnosticSnapshot().errorCode).toBe("DIRECT_UNSAFE_ROUTE");
  });

  test("reports ICE transitions but ignores a retired peer's later callbacks", async () => {
    const { session, peer, events } = await createDirectFixture();
    const oldIce = peer.oniceconnectionstatechange;
    expect(typeof oldIce).toBe("function");
    peer.iceConnectionState = "checking";
    oldIce?.();
    expect(events.at(-1)).toMatchObject({ type: "phase", iceState: "checking" });
    session.closeDirect();
    const frozen = session.getDiagnosticSnapshot();
    peer.iceConnectionState = "failed";
    oldIce?.();
    expect(session.getDiagnosticSnapshot()).toEqual(frozen);
    session.leave();
  });

  test.each([
    [{ type: "error", code: "ROOM_UNAVAILABLE", message: "private room 583204" }, "ROOM_NOT_FOUND"],
    [{ type: "room_expired" }, "ROOM_EXPIRED"],
    [{ type: "join_rejected" }, "PEER_REJECTED"],
    [{ type: "peer_left" }, "PEER_LEFT"],
    [{ type: "error", code: "192.168.0.9-secret", message: "secret-path" }, "UNKNOWN"],
  ])("records a sanitized terminal signal %j", async (event, errorCode) => {
    const { session, socket, advance } = await createDirectFixture();
    advance(120);
    socket.receive(event);
    const snapshot = session.getDiagnosticSnapshot();
    expect(snapshot).toMatchObject({ stage: "failed", failedStage: "finding_route", errorCode, elapsedMs: 120, totalElapsedMs: 120 });
    session.leave();
    expect(session.getDiagnosticSnapshot()).toEqual(snapshot);
    expect(JSON.stringify(snapshot)).not.toMatch(/192\.168|secret|583204/);
  });

  test("signal offline freezes its true state and a later connect resets diagnostics", async () => {
    const { session, socket, advance } = await createDirectFixture();
    advance(315);
    socket.close();
    expect(session.getDiagnosticSnapshot()).toMatchObject({ stage: "failed", errorCode: "SIGNAL_OFFLINE", signalingState: "closed", elapsedMs: 315 });
    session.leave();
    const reconnect = session.connect();
    expect(session.getDiagnosticSnapshot()).toMatchObject({ stage: "connecting_signal", errorCode: null, failedStage: null, elapsedMs: 0, totalElapsedMs: 0, localCandidateType: "unknown" });
    FakeWebSocket.instances.at(-1)!.open();
    await reconnect;
    session.leave();
  });

  test("both sides enter approval waiting from actual room events, not a fixed timeout", async () => {
    const { session, socket, events, advance } = await createDirectFixture();
    session.closeDirect();
    advance(240);
    socket.receive({ type: "join_waiting", expiresAt: 600_000 });
    expect(session.getDiagnosticSnapshot()).toMatchObject({ stage: "waiting_approval", elapsedMs: 0 });
    advance(75);
    socket.receive({ type: "join_requested" });
    expect(session.getDiagnosticSnapshot()).toMatchObject({ stage: "waiting_approval", elapsedMs: 75 });
    expect(events.filter((event) => event.type === "phase" && event.stage === "waiting_approval")).toHaveLength(2);
    session.leave();
  });

  test("unexpected native state values cannot escape the diagnostic enum whitelist", async () => {
    const { session, socket, peer } = await createDirectFixture();
    socket.readyState = "map" as any;
    peer.connectionState = "192.168.9.8";
    peer.iceConnectionState = "secret-sdp";
    expect(session.getDiagnosticSnapshot()).toMatchObject({
      signalingState: "unknown", connectionState: "unknown", iceState: "unknown",
    });
    session.leave();
  });

  test("each room lookup reports its own failure so a later rate limit replaces the old not-found diagnostic", async () => {
    const { session, socket, advance } = await createDirectFixture(FakePeerConnection, false);
    for (const [responseMs, serverCode, diagnosticCode] of [
      [11, "ROOM_UNAVAILABLE", "ROOM_NOT_FOUND"],
      [12, "ROOM_UNAVAILABLE", "ROOM_NOT_FOUND"],
      [13, "ROOM_UNAVAILABLE", "ROOM_NOT_FOUND"],
      [14, "ROOM_UNAVAILABLE", "ROOM_NOT_FOUND"],
      [15, "ROOM_UNAVAILABLE", "ROOM_NOT_FOUND"],
      [16, "RATE_LIMITED", "RATE_LIMITED"],
    ] as const) {
      advance(500);
      session.joinRoom("000000");
      expect(session.getDiagnosticSnapshot()).toMatchObject({ stage: "joining_room", failedStage: null, errorCode: null, elapsedMs: 0 });
      advance(responseMs);
      socket.receive({ type: "error", code: serverCode });
      expect(session.getDiagnosticSnapshot()).toMatchObject({ stage: "failed", failedStage: "joining_room", errorCode: diagnosticCode, elapsedMs: responseMs });
    }
    expect(session.getDiagnosticSnapshot()).toMatchObject({ errorCode: "RATE_LIMITED", elapsedMs: 16, totalElapsedMs: 3_081 });
    expect(socket.readyState).toBe(1);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(socket.sent.map((payload) => JSON.parse(payload))).toEqual(Array.from({ length: 6 }, () => ({ type: "join_room", code: "000000" })));
    session.leave();
    expect(session.getDiagnosticSnapshot()).toMatchObject({ errorCode: "RATE_LIMITED", elapsedMs: 16 });
  });

  test("a new lookup resets the stage clock even when another lookup was still pending", async () => {
    const { session, advance } = await createDirectFixture(FakePeerConnection, false);
    advance(100);
    session.joinRoom("000000");
    advance(200);
    session.joinRoom("111111");
    advance(55);
    expect(session.getDiagnosticSnapshot()).toMatchObject({ stage: "joining_room", elapsedMs: 55, totalElapsedMs: 355 });
    session.leave();
  });

  test("a join request that cannot be sent preserves the existing failure evidence", async () => {
    const { session, socket, advance } = await createDirectFixture(FakePeerConnection, false);
    session.joinRoom("000000");
    advance(17);
    socket.receive({ type: "error", code: "ROOM_UNAVAILABLE" });
    const failed = session.getDiagnosticSnapshot();
    socket.readyState = 3;
    expect(() => session.joinRoom("111111")).toThrow("signaling socket is not open");
    expect(session.getDiagnosticSnapshot()).toEqual(failed);
    session.leave();
  });

  test("rejecting a pending join returns the sender timeline to waiting for a peer", async () => {
    const { session, socket, advance } = await createDirectFixture(FakePeerConnection, false);
    session.createRoom();
    socket.receive({ type: "room_created", code: "583204", expiresAt: 600_000 });
    socket.receive({ type: "join_requested" });
    advance(250);
    session.rejectJoin();
    expect(session.getDiagnosticSnapshot()).toMatchObject({ stage: "waiting_peer", errorCode: null, elapsedMs: 0, totalElapsedMs: 250 });
    expect(socket.sent.at(-1)).toBe(JSON.stringify({ type: "reject_join" }));
    session.leave();
  });
});

describe("PeerSession signaling", () => {
  test("deduplicates an in-flight connect and leave settles it without reviving a heartbeat", async () => {
    FakeWebSocket.instances = [];
    const events: any[] = [];
    let heartbeatStarts = 0;
    const session = new PeerSession({
      WebSocketImpl: FakeWebSocket,
      location: { protocol: "http:", host: "dukou.local" },
      onEvent: (event: unknown) => events.push(event),
      setIntervalImpl: () => { heartbeatStarts += 1; return heartbeatStarts; },
      clearIntervalImpl: () => {},
    });
    const first = session.connect();
    expect(session.connect()).toBe(first);
    const oldSocket = FakeWebSocket.instances[0];
    const oldOpen = oldSocket.onopen!;
    let error: unknown;
    first.catch((failure: unknown) => { error = failure; });
    session.leave();
    await Promise.resolve();
    expect(error).toBeInstanceOf(Error);
    const next = session.connect();
    const newSocket = FakeWebSocket.instances.at(-1)!;
    newSocket.open();
    await next;
    oldOpen();
    expect(heartbeatStarts).toBe(1);
    expect(events.filter((event) => event.type === "signaling" && event.state === "online")).toHaveLength(1);
    expect(oldSocket.onopen).toBeNull();
    session.leave();
  });

  test.each(["close", "error"])("a socket %s before open rejects and ignores a late open", async (kind) => {
    FakeWebSocket.instances = [];
    let heartbeatStarts = 0;
    const session = new PeerSession({
      WebSocketImpl: FakeWebSocket,
      location: { protocol: "http:", host: "dukou.local" },
      setIntervalImpl: () => { heartbeatStarts += 1; return heartbeatStarts; },
      clearIntervalImpl: () => {},
    });
    let error: unknown;
    session.connect().catch((failure: unknown) => { error = failure; });
    const socket = FakeWebSocket.instances[0];
    const lateOpen = socket.onopen!;
    if (kind === "close") socket.close();
    else socket.onerror?.();
    await Promise.resolve();
    expect(error).toBeInstanceOf(Error);
    lateOpen();
    expect(heartbeatStarts).toBe(0);
    expect(session.socket).toBeNull();
    session.leave();
  });

  test("an old createOffer continuation cannot mutate or signal through a later peer", async () => {
    FakeWebSocket.instances = [];
    FakePeerConnection.instances = [];
    let finishOffer!: (value: { type: string; sdp: string }) => void;
    class DeferredOfferPeer extends FakePeerConnection {
      async createOffer() { return new Promise<{ type: string; sdp: string }>((resolve) => { finishOffer = resolve; }); }
    }
    const session = new PeerSession({
      WebSocketImpl: FakeWebSocket,
      RTCPeerConnectionImpl: DeferredOfferPeer,
      location: { protocol: "http:", host: "dukou.local" },
    });
    const connected = session.connect();
    FakeWebSocket.instances[0].open();
    await connected;
    const oldNegotiation = session.startPeer("sender");
    session.leave();
    const reconnected = session.connect();
    const newSocket = FakeWebSocket.instances.at(-1)!;
    newSocket.open();
    await reconnected;
    await session.startPeer("receiver");
    const newPeer = FakePeerConnection.instances.at(-1)!;
    finishOffer({ type: "offer", sdp: "old-secret-sdp" });
    await oldNegotiation;
    expect(newPeer.localDescription).toBeNull();
    expect(newSocket.sent).toEqual([]);
    session.leave();
  });

  test("late stats from an old peer cannot close the next peer's channel", async () => {
    FakeWebSocket.instances = [];
    FakePeerConnection.instances = [];
    const events: any[] = [];
    const session = new PeerSession({
      WebSocketImpl: FakeWebSocket,
      RTCPeerConnectionImpl: FakePeerConnection,
      location: { protocol: "http:", host: "dukou.local" },
      onEvent: (event: unknown) => events.push(event),
    });
    const connected = session.connect();
    FakeWebSocket.instances[0].open();
    await connected;
    await session.startPeer("sender");
    const oldPeer = FakePeerConnection.instances[0];
    let finishStats!: (stats: Map<string, any>) => void;
    oldPeer.getStats = () => new Promise((resolve) => { finishStats = resolve; });
    const inspecting = session.inspectDirectPath();
    session.leave();
    const reconnected = session.connect();
    FakeWebSocket.instances.at(-1)!.open();
    await reconnected;
    await session.startPeer("sender");
    const newChannel = FakePeerConnection.instances.at(-1)!.channel!;
    finishStats(new Map([
      ["pair", { type: "candidate-pair", selected: true, localCandidateId: "local", remoteCandidateId: "remote" }],
      ["local", { candidateType: "relay" }],
      ["remote", { candidateType: "relay" }],
    ]));
    await inspecting;
    expect(newChannel.readyState).toBe("connecting");
    expect(events.filter((event) => event.type === "direct_path")).toEqual([]);
    session.leave();
  });

  test("leaving in a peer_joined callback cannot create a peer or deadlines afterwards", async () => {
    FakeWebSocket.instances = [];
    FakePeerConnection.instances = [];
    let deadlines = 0;
    const session = new PeerSession({
      WebSocketImpl: FakeWebSocket,
      RTCPeerConnectionImpl: FakePeerConnection,
      location: { protocol: "http:", host: "dukou.local" },
      onEvent: (event: any) => { if (event.type === "peer_joined") session.leave(); },
      setTimeoutImpl: () => { deadlines += 1; return deadlines; },
      clearTimeoutImpl: () => {},
    });
    const connected = session.connect();
    FakeWebSocket.instances[0].open();
    await connected;
    FakeWebSocket.instances[0].receive({ type: "peer_joined", role: "sender" });
    await Promise.resolve();
    expect(FakePeerConnection.instances).toHaveLength(0);
    expect(deadlines).toBe(0);
    session.leave();
  });

  test("reports a slow direct route at 8 seconds and fails it at 20 seconds", async () => {
    FakeWebSocket.instances = [];
    FakePeerConnection.instances = [];
    const timers = new Map<number, () => void>();
    const events: any[] = [];
    const session = new PeerSession({
      WebSocketImpl: FakeWebSocket,
      RTCPeerConnectionImpl: FakePeerConnection,
      location: { protocol: "http:", host: "127.0.0.1:3210" },
      onEvent: (event: unknown) => events.push(event),
      setTimeoutImpl: (callback: () => void, delay: number) => {
        timers.set(delay, callback);
        return delay;
      },
      clearTimeoutImpl: (token: number) => timers.delete(token),
    });
    const connected = session.connect();
    const socket = FakeWebSocket.instances[0];
    socket.open();
    await connected;
    socket.receive({ type: "peer_joined", role: "sender" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    timers.get(8_000)?.();
    expect(events).toContainEqual({ type: "direct_connection", state: "slow", elapsedMs: 8_000 });
    timers.get(20_000)?.();
    expect(events).toContainEqual(expect.objectContaining({ type: "direct_failed", code: "DIRECT_TIMEOUT" }));
    expect(FakePeerConnection.instances[0].connectionState).toBe("closed");
    session.leave();
  });

  test("verifying the data channel route cancels both direct connection deadlines", async () => {
    FakeWebSocket.instances = [];
    FakePeerConnection.instances = [];
    const cleared: number[] = [];
    const session = new PeerSession({
      WebSocketImpl: FakeWebSocket,
      RTCPeerConnectionImpl: FakePeerConnection,
      location: { protocol: "http:", host: "127.0.0.1:3210" },
      setTimeoutImpl: (_callback: () => void, delay: number) => delay,
      clearTimeoutImpl: (token: number) => cleared.push(token),
    });
    const connected = session.connect();
    const socket = FakeWebSocket.instances[0];
    socket.open();
    await connected;
    socket.receive({ type: "peer_joined", role: "sender" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    FakePeerConnection.instances[0].channel?.onopen?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(cleared).toEqual([8_000, 20_000]);
    session.leave();
  });

  test("keeps signaling alive with a bounded heartbeat and clears it on leave", async () => {
    FakeWebSocket.instances = [];
    let tick: (() => void) | null = null;
    let cleared: unknown = null;
    const timerToken = { id: "heartbeat" };
    const session = new PeerSession({
      WebSocketImpl: FakeWebSocket,
      location: { protocol: "http:", host: "127.0.0.1:3210" },
      setIntervalImpl: (callback: () => void, delay: number) => {
        expect(delay).toBe(15_000);
        tick = callback;
        return timerToken;
      },
      clearIntervalImpl: (token: unknown) => {
        cleared = token;
      },
    });

    const connected = session.connect();
    const socket = FakeWebSocket.instances[0];
    socket.open();
    await connected;
    tick?.();

    expect(socket.sent).toEqual([JSON.stringify({ type: "ping", nonce: "hb-1" })]);
    session.leave();
    expect(cleared).toBe(timerToken);
  });

  test("connects to the same-origin websocket and creates a room", async () => {
    FakeWebSocket.instances = [];
    const events: unknown[] = [];
    const session = new PeerSession({
      WebSocketImpl: FakeWebSocket,
      location: { protocol: "https:", host: "dukoutest.local" },
      onEvent: (event: unknown) => events.push(event),
    });

    const connected = session.connect();
    const socket = FakeWebSocket.instances[0];
    socket.open();
    await connected;
    session.createRoom();
    socket.receive({ type: "room_created", code: "583204", expiresAt: 601_000 });

    expect(socket.url).toBe("wss://dukoutest.local/ws");
    expect(socket.sent).toEqual([JSON.stringify({ type: "create_room" })]);
    expect(events).toContainEqual({ type: "signaling", state: "online" });
    expect(events).toContainEqual({
      type: "room_created",
      code: "583204",
      expiresAt: 601_000,
    });
  });

  test("approved sender creates an ordered direct channel and relays an offer", async () => {
    FakeWebSocket.instances = [];
    FakePeerConnection.instances = [];
    const session = new PeerSession({
      WebSocketImpl: FakeWebSocket,
      RTCPeerConnectionImpl: FakePeerConnection,
      location: { protocol: "http:", host: "127.0.0.1:3210" },
    });
    const connected = session.connect();
    const socket = FakeWebSocket.instances[0];
    socket.open();
    await connected;
    session.createRoom();

    socket.receive({ type: "peer_joined", role: "sender" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const peer = FakePeerConnection.instances[0];
    expect(peer.configuration).toEqual({ iceServers: [] });
    expect(peer.channel).toMatchObject({
      label: "dukout-transfer",
      options: { ordered: true },
      binaryType: "arraybuffer",
    });
    expect(socket.sent.at(-1)).toBe(
      JSON.stringify({
        type: "signal",
        signal: { type: "offer", sdp: "sender-sdp" },
      }),
    );
  });

  test("receiver answers an offer and applies remote ICE candidates", async () => {
    FakeWebSocket.instances = [];
    FakePeerConnection.instances = [];
    const session = new PeerSession({
      WebSocketImpl: FakeWebSocket,
      RTCPeerConnectionImpl: FakePeerConnection,
      location: { protocol: "http:", host: "127.0.0.1:3210" },
    });
    const connected = session.connect();
    const socket = FakeWebSocket.instances[0];
    socket.open();
    await connected;
    session.joinRoom("583204");
    socket.receive({ type: "peer_joined", role: "receiver" });
    socket.receive({
      type: "signal",
      signal: { type: "offer", sdp: "sender-sdp" },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const peer = FakePeerConnection.instances[0];
    expect(peer.remoteDescription).toEqual({ type: "offer", sdp: "sender-sdp" });
    expect(peer.localDescription).toEqual({ type: "answer", sdp: "receiver-sdp" });
    expect(socket.sent.at(-1)).toBe(
      JSON.stringify({
        type: "signal",
        signal: { type: "answer", sdp: "receiver-sdp" },
      }),
    );

    socket.receive({
      type: "signal",
      signal: {
        type: "candidate",
        candidate: "candidate:1 1 UDP 1 192.168.1.3 9999 typ host",
        sdpMid: "0",
        sdpMLineIndex: 0,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(peer.candidates).toEqual([
      {
        candidate: "candidate:1 1 UDP 1 192.168.1.3 9999 typ host",
        sdpMid: "0",
        sdpMLineIndex: 0,
      },
    ]);
  });

  test("reports a verified non-relay route when the data channel opens", async () => {
    FakeWebSocket.instances = [];
    FakePeerConnection.instances = [];
    const events: unknown[] = [];
    const session = new PeerSession({
      WebSocketImpl: FakeWebSocket,
      RTCPeerConnectionImpl: FakePeerConnection,
      location: { protocol: "http:", host: "127.0.0.1:3210" },
      onEvent: (event: unknown) => events.push(event),
    });
    const connected = session.connect();
    const socket = FakeWebSocket.instances[0];
    socket.open();
    await connected;
    session.createRoom();
    socket.receive({ type: "peer_joined", role: "sender" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const channel = FakePeerConnection.instances[0].channel!;
    channel.readyState = "open";
    channel.onopen?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(events).toContainEqual({
      type: "direct_path",
      direct: true,
      localCandidateType: "host",
      remoteCandidateType: "host",
    });
  });

  test("closes a relay route and reports it exactly once", async () => {
    FakeWebSocket.instances = [];
    FakePeerConnection.instances = [];
    FakePeerConnection.candidateType = "relay";
    const events: Array<Record<string, unknown>> = [];
    const session = new PeerSession({
      WebSocketImpl: FakeWebSocket,
      RTCPeerConnectionImpl: FakePeerConnection,
      location: { protocol: "http:", host: "127.0.0.1:3210" },
      onEvent: (event: Record<string, unknown>) => events.push(event),
    });
    const connected = session.connect();
    const socket = FakeWebSocket.instances[0];
    socket.open();
    await connected;
    session.createRoom();
    socket.receive({ type: "peer_joined", role: "sender" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const channel = FakePeerConnection.instances[0].channel!;

    channel.onopen?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(events.filter((event) => event.type === "direct_path")).toEqual([
      {
        type: "direct_path",
        direct: false,
        localCandidateType: "relay",
        remoteCandidateType: "relay",
      },
    ]);
    expect(channel.readyState).toBe("closed");
    FakePeerConnection.candidateType = "host";
  });

  for (const candidateType of ["unknown", undefined]) {
    test(`does not certify ${candidateType ?? "missing"} candidate types as direct`, async () => {
      FakeWebSocket.instances = [];
      FakePeerConnection.instances = [];
      FakePeerConnection.candidateType = candidateType;
      const events: Array<Record<string, unknown>> = [];
      const session = new PeerSession({
        WebSocketImpl: FakeWebSocket,
        RTCPeerConnectionImpl: FakePeerConnection,
        location: { protocol: "http:", host: "127.0.0.1:3210" },
        onEvent: (event: Record<string, unknown>) => events.push(event),
      });
      const connected = session.connect();
      const socket = FakeWebSocket.instances[0];
      socket.open();
      await connected;
      session.createRoom();
      socket.receive({ type: "peer_joined", role: "sender" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      const channel = FakePeerConnection.instances[0].channel!;

      channel.onopen?.();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(events.filter((event) => event.type === "direct_path")).toEqual([
        {
          type: "direct_path",
          direct: false,
          localCandidateType: "unknown",
          remoteCandidateType: "unknown",
        },
      ]);
      expect(channel.readyState).toBe("closed");
      FakePeerConnection.candidateType = "host";
    });
  }
});
