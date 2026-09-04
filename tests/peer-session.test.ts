import { describe, expect, test } from "bun:test";
import { PeerSession } from "../src/web/peer-session.js";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  sent: string[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;

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
  connectionState = "new";
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
  }
}

describe("PeerSession signaling", () => {
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
    expect(events).toContainEqual({ type: "error", code: "DIRECT_TIMEOUT", elapsedMs: 20_000 });
    expect(FakePeerConnection.instances[0].connectionState).toBe("closed");
  });

  test("opening the data channel cancels both direct connection deadlines", async () => {
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

    expect(cleared).toEqual([8_000, 20_000]);
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
