import { describe, expect, test } from "bun:test";
import { SignalingCore } from "../src/signaling-core";


function makeCore(codes: string[] = ["583204"]) {
  let now = 1_000;
  let index = 0;
  const core = new SignalingCore(
    {
      roomTtlMs: 600_000,
      maxMessageBytes: 65_536,
      joinRateLimit: { maxAttempts: 5, windowMs: 60_000 },
    },
    {
      now: () => now,
      nextRoomCode: () => codes[index++] ?? "999999",
      nextRelayCredential: (() => {
        const values = ["relay-session", "sender-token", "receiver-token"];
        return () => values.shift() ?? "extra-token";
      })(),
    },
  );

  return {
    core,
    advance(ms: number) {
      now += ms;
    },
  };
}


describe("SignalingCore rooms", () => {
  test("requires sender request and receiver approval before authorizing a relay", () => {
    const { core } = makeCore();
    core.connect({ id: "sender", clientKey: "10.0.0.1" });
    core.connect({ id: "receiver", clientKey: "10.0.0.2" });
    core.receive("sender", JSON.stringify({ type: "create_room" }));
    core.receive("receiver", JSON.stringify({ type: "join_room", code: "583204" }));
    core.receive("sender", JSON.stringify({ type: "approve_join" }));

    expect(core.receive("sender", JSON.stringify({ type: "request_relay" }))).toEqual([
      { kind: "send", peerId: "receiver", message: { type: "relay_requested" } },
    ]);
    expect(core.receive("receiver", JSON.stringify({ type: "approve_relay" }))).toEqual([
      {
        kind: "authorize_relay",
        sessionId: "relay-session",
        senderToken: "sender-token",
        receiverToken: "receiver-token",
      },
      {
        kind: "send",
        peerId: "sender",
        message: { type: "relay_ready", token: "sender-token", role: "sender" },
      },
      {
        kind: "send",
        peerId: "receiver",
        message: { type: "relay_ready", token: "receiver-token", role: "receiver" },
      },
    ]);
  });
  test("create_room returns a six-digit room code with a fixed expiry", () => {
    const { core } = makeCore();
    core.connect({ id: "sender", clientKey: "192.168.1.2" });

    const actions = core.receive("sender", JSON.stringify({ type: "create_room" }));

    expect(actions).toEqual([
      {
        kind: "send",
        peerId: "sender",
        message: {
          type: "room_created",
          code: "583204",
          expiresAt: 601_000,
        },
      },
    ]);
  });

  test("create_room preserves leading zeroes and skips active-code collisions", () => {
    const { core } = makeCore(["000042", "000042", "000043"]);
    core.connect({ id: "sender-a", clientKey: "192.168.1.2" });
    core.connect({ id: "sender-b", clientKey: "192.168.1.3" });

    const first = core.receive("sender-a", JSON.stringify({ type: "create_room" }));
    const second = core.receive("sender-b", JSON.stringify({ type: "create_room" }));

    expect(first[0]).toMatchObject({ message: { code: "000042" } });
    expect(second[0]).toMatchObject({ message: { code: "000043" } });
  });

  test("join_room waits for the sender and approve_join pairs exactly two peers", () => {
    const { core } = makeCore();
    core.connect({ id: "sender", clientKey: "192.168.1.2" });
    core.connect({ id: "receiver", clientKey: "192.168.1.3" });
    core.connect({ id: "late-receiver", clientKey: "192.168.1.4" });
    core.receive("sender", JSON.stringify({ type: "create_room" }));

    const join = core.receive(
      "receiver",
      JSON.stringify({ type: "join_room", code: "583204" }),
    );
    const approval = core.receive("sender", JSON.stringify({ type: "approve_join" }));
    const lateJoin = core.receive(
      "late-receiver",
      JSON.stringify({ type: "join_room", code: "583204" }),
    );

    expect(join).toEqual([
      {
        kind: "send",
        peerId: "receiver",
        message: { type: "join_waiting", expiresAt: 601_000 },
      },
      {
        kind: "send",
        peerId: "sender",
        message: { type: "join_requested" },
      },
    ]);
    expect(approval).toEqual([
      {
        kind: "send",
        peerId: "sender",
        message: { type: "peer_joined", role: "sender" },
      },
      {
        kind: "send",
        peerId: "receiver",
        message: { type: "peer_joined", role: "receiver" },
      },
    ]);
    expect(lateJoin).toEqual([
      {
        kind: "send",
        peerId: "late-receiver",
        message: {
          type: "error",
          code: "ROOM_UNAVAILABLE",
          message: "接收码无效、已过期或正在使用",
        },
      },
    ]);
  });

  test("reject_join releases the pending slot so another receiver can request it", () => {
    const { core } = makeCore();
    core.connect({ id: "sender", clientKey: "10.0.0.1" });
    core.connect({ id: "receiver-a", clientKey: "10.0.0.2" });
    core.connect({ id: "receiver-b", clientKey: "10.0.0.3" });
    core.receive("sender", JSON.stringify({ type: "create_room" }));
    core.receive("receiver-a", JSON.stringify({ type: "join_room", code: "583204" }));

    const rejection = core.receive("sender", JSON.stringify({ type: "reject_join" }));
    const nextJoin = core.receive(
      "receiver-b",
      JSON.stringify({ type: "join_room", code: "583204" }),
    );

    expect(rejection).toEqual([
      {
        kind: "send",
        peerId: "receiver-a",
        message: { type: "join_rejected" },
      },
    ]);
    expect(nextJoin).toEqual([
      {
        kind: "send",
        peerId: "receiver-b",
        message: { type: "join_waiting", expiresAt: 601_000 },
      },
      {
        kind: "send",
        peerId: "sender",
        message: { type: "join_requested" },
      },
    ]);
  });

  test("forwards WebRTC offers and answers only to the approved peer", () => {
    const { core } = makeCore();
    core.connect({ id: "sender", clientKey: "10.0.0.1" });
    core.connect({ id: "receiver", clientKey: "10.0.0.2" });
    core.receive("sender", JSON.stringify({ type: "create_room" }));
    core.receive("receiver", JSON.stringify({ type: "join_room", code: "583204" }));
    core.receive("sender", JSON.stringify({ type: "approve_join" }));

    const offer = core.receive(
      "sender",
      JSON.stringify({ type: "signal", signal: { type: "offer", sdp: "sender-sdp" } }),
    );
    const answer = core.receive(
      "receiver",
      JSON.stringify({ type: "signal", signal: { type: "answer", sdp: "receiver-sdp" } }),
    );
    const invalid = core.receive(
      "receiver",
      JSON.stringify({ type: "signal", signal: { type: "offer", sdp: "spoofed" } }),
    );

    expect(offer).toEqual([
      {
        kind: "send",
        peerId: "receiver",
        message: { type: "signal", signal: { type: "offer", sdp: "sender-sdp" } },
      },
    ]);
    expect(answer).toEqual([
      {
        kind: "send",
        peerId: "sender",
        message: { type: "signal", signal: { type: "answer", sdp: "receiver-sdp" } },
      },
    ]);
    expect(invalid).toEqual([
      {
        kind: "send",
        peerId: "receiver",
        message: {
          type: "error",
          code: "ROLE_VIOLATION",
          message: "当前角色不能发送此类连接信息",
        },
      },
    ]);
  });

  test("forwards ICE candidates in both directions without exposing room routing", () => {
    const { core } = makeCore();
    core.connect({ id: "sender", clientKey: "10.0.0.1" });
    core.connect({ id: "receiver", clientKey: "10.0.0.2" });
    core.receive("sender", JSON.stringify({ type: "create_room" }));
    core.receive("receiver", JSON.stringify({ type: "join_room", code: "583204" }));
    core.receive("sender", JSON.stringify({ type: "approve_join" }));

    const candidate = {
      type: "candidate",
      candidate: "candidate:1 1 UDP 2122252543 192.168.1.2 53165 typ host",
      sdpMid: "0",
      sdpMLineIndex: 0,
    };
    const senderCandidate = core.receive(
      "sender",
      JSON.stringify({ type: "signal", signal: candidate }),
    );
    const receiverCandidate = core.receive(
      "receiver",
      JSON.stringify({ type: "signal", signal: candidate }),
    );

    expect(senderCandidate).toEqual([
      {
        kind: "send",
        peerId: "receiver",
        message: { type: "signal", signal: candidate },
      },
    ]);
    expect(receiverCandidate).toEqual([
      {
        kind: "send",
        peerId: "sender",
        message: { type: "signal", signal: candidate },
      },
    ]);
  });

  test("rejects client-selected signal routing fields", () => {
    const { core } = makeCore();
    core.connect({ id: "sender", clientKey: "10.0.0.1" });
    core.connect({ id: "receiver", clientKey: "10.0.0.2" });
    core.receive("sender", JSON.stringify({ type: "create_room" }));
    core.receive("receiver", JSON.stringify({ type: "join_room", code: "583204" }));
    core.receive("sender", JSON.stringify({ type: "approve_join" }));

    const actions = core.receive(
      "sender",
      JSON.stringify({
        type: "signal",
        to: "someone-else",
        signal: { type: "offer", sdp: "sender-sdp" },
      }),
    );

    expect(actions).toEqual([
      {
        kind: "send",
        peerId: "sender",
        message: {
          type: "error",
          code: "INVALID_MESSAGE",
          message: "连接信息包含不允许的字段",
        },
      },
    ]);
  });

  test("sweepExpiredRooms notifies participants once and releases the room", () => {
    const { core, advance } = makeCore(["583204", "583205"]);
    core.connect({ id: "sender", clientKey: "10.0.0.1" });
    core.connect({ id: "receiver", clientKey: "10.0.0.2" });
    core.receive("sender", JSON.stringify({ type: "create_room" }));
    core.receive("receiver", JSON.stringify({ type: "join_room", code: "583204" }));
    advance(600_000);

    const expired = core.sweepExpiredRooms();
    const repeatedSweep = core.sweepExpiredRooms();
    const replacement = core.receive("sender", JSON.stringify({ type: "create_room" }));

    expect(expired).toEqual([
      { kind: "send", peerId: "sender", message: { type: "room_expired" } },
      { kind: "send", peerId: "receiver", message: { type: "room_expired" } },
    ]);
    expect(repeatedSweep).toEqual([]);
    expect(replacement[0]).toMatchObject({
      peerId: "sender",
      message: { type: "room_created", code: "583205" },
    });
  });

  test("an expired join lazily removes the room and releases its sender", () => {
    const { core, advance } = makeCore(["583204", "583205"]);
    core.connect({ id: "sender", clientKey: "10.0.0.1" });
    core.connect({ id: "receiver", clientKey: "10.0.0.2" });
    core.receive("sender", JSON.stringify({ type: "create_room" }));
    advance(600_000);

    const join = core.receive(
      "receiver",
      JSON.stringify({ type: "join_room", code: "583204" }),
    );
    const replacement = core.receive("sender", JSON.stringify({ type: "create_room" }));

    expect(join).toEqual([
      { kind: "send", peerId: "sender", message: { type: "room_expired" } },
      {
        kind: "send",
        peerId: "receiver",
        message: {
          type: "error",
          code: "ROOM_UNAVAILABLE",
          message: "接收码无效、已过期或正在使用",
        },
      },
    ]);
    expect(replacement[0]).toMatchObject({ message: { code: "583205" } });
  });

  test("approve_join at the expiry boundary expires the pending room without pairing", () => {
    const { core, advance } = makeCore(["583204", "583205", "583206"]);
    core.connect({ id: "sender", clientKey: "10.0.0.1" });
    core.connect({ id: "receiver", clientKey: "10.0.0.2" });
    core.receive("sender", JSON.stringify({ type: "create_room" }));
    core.receive("receiver", JSON.stringify({ type: "join_room", code: "583204" }));
    advance(600_000);

    const approval = core.receive("sender", JSON.stringify({ type: "approve_join" }));

    expect(approval).toEqual([
      { kind: "send", peerId: "sender", message: { type: "room_expired" } },
      { kind: "send", peerId: "receiver", message: { type: "room_expired" } },
    ]);
    expect(core.sweepExpiredRooms()).toEqual([]);
    expect(core.receive("sender", JSON.stringify({ type: "create_room" }))[0]).toMatchObject({
      message: { code: "583205" },
    });
    expect(core.receive("receiver", JSON.stringify({ type: "create_room" }))[0]).toMatchObject({
      message: { code: "583206" },
    });
  });

  test("a paired room is no longer expired by its pre-pairing creation TTL", () => {
    const { core, advance } = makeCore(["583204", "583205", "583206"]);
    core.connect({ id: "sender", clientKey: "10.0.0.1" });
    core.connect({ id: "receiver", clientKey: "10.0.0.2" });
    core.receive("sender", JSON.stringify({ type: "create_room" }));
    core.receive("receiver", JSON.stringify({ type: "join_room", code: "583204" }));
    core.receive("sender", JSON.stringify({ type: "approve_join" }));
    advance(600_000);

    const relay = core.receive(
      "sender",
      JSON.stringify({
        type: "signal",
        signal: { type: "offer", sdp: "must-not-be-forwarded" },
      }),
    );

    expect(relay).toEqual([
      {
        kind: "send",
        peerId: "receiver",
        message: {
          type: "signal",
          signal: { type: "offer", sdp: "must-not-be-forwarded" },
        },
      },
    ]);
    expect(core.sweepExpiredRooms()).toEqual([]);
    expect(core.receive("sender", JSON.stringify({ type: "create_room" }))[0]).toMatchObject({
      message: { code: "ALREADY_IN_ROOM" },
    });
  });

  test("disconnecting either paired peer closes the room and releases the survivor", () => {
    const { core } = makeCore(["583204", "583205"]);
    core.connect({ id: "sender", clientKey: "10.0.0.1" });
    core.connect({ id: "receiver", clientKey: "10.0.0.2" });
    core.receive("sender", JSON.stringify({ type: "create_room" }));
    core.receive("receiver", JSON.stringify({ type: "join_room", code: "583204" }));
    core.receive("sender", JSON.stringify({ type: "approve_join" }));

    const disconnected = core.disconnect("receiver");
    const replacement = core.receive("sender", JSON.stringify({ type: "create_room" }));
    const repeated = core.disconnect("receiver");

    expect(disconnected).toEqual([
      { kind: "send", peerId: "sender", message: { type: "peer_left" } },
    ]);
    expect(replacement[0]).toMatchObject({
      peerId: "sender",
      message: { type: "room_created", code: "583205" },
    });
    expect(repeated).toEqual([]);
  });

  test("leave closes a paired room while keeping both websocket peers reusable", () => {
    const { core } = makeCore(["583204", "583205", "583206"]);
    core.connect({ id: "sender", clientKey: "10.0.0.1" });
    core.connect({ id: "receiver", clientKey: "10.0.0.2" });
    core.receive("sender", JSON.stringify({ type: "create_room" }));
    core.receive("receiver", JSON.stringify({ type: "join_room", code: "583204" }));
    core.receive("sender", JSON.stringify({ type: "approve_join" }));

    const left = core.receive("sender", JSON.stringify({ type: "leave" }));
    const senderAgain = core.receive("sender", JSON.stringify({ type: "create_room" }));
    const receiverAgain = core.receive("receiver", JSON.stringify({ type: "create_room" }));

    expect(left).toEqual([
      { kind: "send", peerId: "receiver", message: { type: "peer_left" } },
    ]);
    expect(senderAgain[0]).toMatchObject({ message: { code: "583205" } });
    expect(receiverAgain[0]).toMatchObject({ message: { code: "583206" } });
  });
});

describe("SignalingCore input boundaries", () => {
  test("responds to a bounded application heartbeat", () => {
    const { core } = makeCore();
    core.connect({ id: "peer", clientKey: "10.0.0.1" });

    const actions = core.receive(
      "peer",
      JSON.stringify({ type: "ping", nonce: "heartbeat-1" }),
    );

    expect(actions).toEqual([
      {
        kind: "send",
        peerId: "peer",
        message: { type: "pong", nonce: "heartbeat-1" },
      },
    ]);
  });

  test("closes a peer that sends binary websocket data", () => {
    const { core } = makeCore();
    core.connect({ id: "peer", clientKey: "10.0.0.1" });

    const actions = core.receive("peer", new Uint8Array([1, 2, 3]));

    expect(actions).toEqual([
      { kind: "close", peerId: "peer", code: 1003, reason: "text messages only" },
    ]);
  });

  test("counts UTF-8 bytes and closes oversized text before parsing", () => {
    const core = new SignalingCore(
      {
        roomTtlMs: 600_000,
        maxMessageBytes: 4,
        joinRateLimit: { maxAttempts: 5, windowMs: 60_000 },
      },
      { now: () => 1_000, nextRoomCode: () => "583204" },
    );
    core.connect({ id: "peer", clientKey: "10.0.0.1" });

    const actions = core.receive("peer", "你你");

    expect(actions).toEqual([
      { kind: "close", peerId: "peer", code: 1009, reason: "message too large" },
    ]);
  });

  test("closes malformed JSON and rejects unknown commands", () => {
    const { core } = makeCore();
    core.connect({ id: "peer", clientKey: "10.0.0.1" });

    const malformed = core.receive("peer", "{");
    const unknown = core.receive("peer", JSON.stringify({ type: "upload_file" }));

    expect(malformed).toEqual([
      { kind: "close", peerId: "peer", code: 1007, reason: "invalid json" },
    ]);
    expect(unknown).toEqual([
      {
        kind: "send",
        peerId: "peer",
        message: { type: "error", code: "INVALID_MESSAGE", message: "未知的信令命令" },
      },
    ]);
  });
});

describe("SignalingCore join rate limiting", () => {
  test("limits unavailable-code attempts by client key across reconnects", () => {
    const { core } = makeCore();
    core.connect({ id: "scanner-a", clientKey: "10.0.0.9" });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const actions = core.receive(
        "scanner-a",
        JSON.stringify({ type: "join_room", code: `00000${attempt}` }),
      );
      expect(actions[0]).toMatchObject({ message: { code: "ROOM_UNAVAILABLE" } });
    }
    core.disconnect("scanner-a");
    core.connect({ id: "scanner-b", clientKey: "10.0.0.9" });

    const limited = core.receive(
      "scanner-b",
      JSON.stringify({ type: "join_room", code: "583204" }),
    );

    expect(limited).toEqual([
      {
        kind: "send",
        peerId: "scanner-b",
        message: {
          type: "error",
          code: "RATE_LIMITED",
          message: "尝试次数过多，请稍后重试",
          retryAfterMs: 60_000,
        },
      },
    ]);
  });

  test("sweep releases expired join-rate bucket capacity", () => {
    let now = 1_000;
    const core = new SignalingCore(
      {
        roomTtlMs: 600_000,
        maxMessageBytes: 65_536,
        joinRateLimit: { maxAttempts: 5, windowMs: 60_000 },
        limits: { maxJoinRateBuckets: 1 },
      },
      { now: () => now, nextRoomCode: () => "583204" },
    );
    core.connect({ id: "first", clientKey: "10.0.0.1" });
    core.connect({ id: "second", clientKey: "10.0.0.2" });

    const firstAttempt = core.receive(
      "first",
      JSON.stringify({ type: "join_room", code: "000001" }),
    );
    const deniedWhileActive = core.receive(
      "second",
      JSON.stringify({ type: "join_room", code: "000002" }),
    );
    now += 60_000;
    core.sweepExpiredRooms();
    const acceptedAfterSweep = core.receive(
      "second",
      JSON.stringify({ type: "join_room", code: "000002" }),
    );

    expect(firstAttempt[0]).toMatchObject({ message: { code: "ROOM_UNAVAILABLE" } });
    expect(deniedWhileActive[0]).toMatchObject({ message: { code: "RATE_LIMITED" } });
    expect(acceptedAfterSweep[0]).toMatchObject({ message: { code: "ROOM_UNAVAILABLE" } });
  });
});

describe("SignalingCore capacity limits", () => {
  test("connect enforces the per-client peer limit and releases capacity on disconnect", () => {
    const core = new SignalingCore(
      {
        roomTtlMs: 600_000,
        maxMessageBytes: 65_536,
        joinRateLimit: { maxAttempts: 5, windowMs: 60_000 },
        limits: { maxPeers: 3, maxPeersPerClient: 1 },
      },
      { now: () => 1_000, nextRoomCode: () => "583204" },
    );

    expect(core.connect({ id: "first", clientKey: "10.0.0.1" })).toBe(true);
    expect(core.connect({ id: "same-client", clientKey: "10.0.0.1" })).toBe(false);
    expect(core.connect({ id: "other-client", clientKey: "10.0.0.2" })).toBe(true);
    core.disconnect("first");
    expect(core.connect({ id: "same-client", clientKey: "10.0.0.1" })).toBe(true);
  });

  test("connect enforces the total peer limit and releases capacity on disconnect", () => {
    const core = new SignalingCore(
      {
        roomTtlMs: 600_000,
        maxMessageBytes: 65_536,
        joinRateLimit: { maxAttempts: 5, windowMs: 60_000 },
        limits: { maxPeers: 1, maxPeersPerClient: 2 },
      },
      { now: () => 1_000, nextRoomCode: () => "583204" },
    );

    expect(core.connect({ id: "first", clientKey: "10.0.0.1" })).toBe(true);
    expect(core.connect({ id: "second", clientKey: "10.0.0.2" })).toBe(false);
    core.disconnect("first");
    expect(core.connect({ id: "second", clientKey: "10.0.0.2" })).toBe(true);
  });

  test("create_room enforces the room limit and releases capacity on leave", () => {
    const core = new SignalingCore(
      {
        roomTtlMs: 600_000,
        maxMessageBytes: 65_536,
        joinRateLimit: { maxAttempts: 5, windowMs: 60_000 },
        limits: { maxRooms: 1 },
      },
      {
        now: () => 1_000,
        nextRoomCode: (() => {
          const codes = ["583204", "583205"];
          return () => codes.shift() ?? "999999";
        })(),
      },
    );
    core.connect({ id: "first", clientKey: "10.0.0.1" });
    core.connect({ id: "second", clientKey: "10.0.0.2" });

    expect(core.receive("first", JSON.stringify({ type: "create_room" }))[0]).toMatchObject({
      message: { type: "room_created", code: "583204" },
    });
    expect(core.receive("second", JSON.stringify({ type: "create_room" }))).toEqual([
      {
        kind: "send",
        peerId: "second",
        message: {
          type: "error",
          code: "ROOM_CAPACITY",
          message: "暂时无法创建传输，请稍后重试",
        },
      },
    ]);
    core.receive("first", JSON.stringify({ type: "leave" }));
    expect(core.receive("second", JSON.stringify({ type: "create_room" }))[0]).toMatchObject({
      message: { type: "room_created", code: "583205" },
    });
  });
});
