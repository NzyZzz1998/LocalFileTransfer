import { describe, expect, test } from "bun:test";
import { RelayHub } from "../src/relay-hub";

describe("RelayHub", () => {
  test("accepts each role token once and routes only after both peers connect", () => {
    const hub = new RelayHub({ now: () => 1_000, credentialTtlMs: 60_000, maxFrameBytes: 262_144 });
    hub.authorize("session", "sender-token", "receiver-token");
    expect(hub.claim("sender-token", "sender-connection")).toEqual({
      sessionId: "session",
      role: "sender",
    });
    expect(hub.claim("sender-token", "replay")).toBeNull();
    expect(hub.counterpart("sender-connection")).toBeNull();
    expect(hub.claim("receiver-token", "receiver-connection")).toEqual({
      sessionId: "session",
      role: "receiver",
    });
    expect(hub.counterpart("sender-connection")).toBe("receiver-connection");
    expect(hub.counterpart("receiver-connection")).toBe("sender-connection");
  });

  test("rejects oversized frames and releases the whole session on disconnect", () => {
    const hub = new RelayHub({ now: () => 1_000, credentialTtlMs: 60_000, maxFrameBytes: 4 });
    hub.authorize("session", "sender-token", "receiver-token");
    hub.claim("sender-token", "sender");
    hub.claim("receiver-token", "receiver");
    expect(() => hub.validateFrame(new Uint8Array(5))).toThrow("relay frame too large");
    hub.disconnect("sender");
    expect(hub.counterpart("receiver")).toBeNull();
  });

  test("expires unused credentials", () => {
    let now = 1_000;
    const hub = new RelayHub({ now: () => now, credentialTtlMs: 60_000, maxFrameBytes: 4 });
    hub.authorize("session", "sender-token", "receiver-token");
    now = 61_000;
    hub.sweep();
    expect(hub.claim("sender-token", "sender")).toBeNull();
  });

  test("revokes both claimed connections and unused role credentials by room", () => {
    const hub = new RelayHub({ now: () => 1_000, credentialTtlMs: 60_000, maxFrameBytes: 4 });
    hub.authorize("session", "sender-token", "receiver-token", "room", ["client"]);
    hub.claim("sender-token", "sender");

    expect(hub.revokeRoom("room")?.connectionIds).toEqual(["sender"]);
    expect(hub.claim("receiver-token", "receiver")).toBeNull();
    expect(hub.revokeRoom("room")).toBeNull();
  });

  test("bounds issued sessions by room, total capacity and both participant client keys", () => {
    const hub = new RelayHub({
      now: () => 1_000, credentialTtlMs: 60_000, maxFrameBytes: 4,
      maxSessions: 2, maxSessionsPerClient: 1,
    });
    expect(hub.authorize("one", "a", "b", "room-a", ["client-a", "client-b"])).toBe(true);
    expect(hub.authorize("two", "c", "d", "room-a", ["client-c"])).toBe(false);
    expect(hub.authorize("two", "c", "d", "room-b", ["client-b"])).toBe(false);
    expect(hub.authorize("two", "c", "d", "room-b", ["client-c"])).toBe(true);
    expect(hub.authorize("three", "e", "f", "room-c", ["client-d"])).toBe(false);
    hub.revokeRoom("room-a");
    expect(hub.authorize("three", "e", "f", "room-c", ["client-b"])).toBe(true);
  });

  test("sweep closes half-connected sessions and frees all their indexes", () => {
    let now = 1_000;
    const hub = new RelayHub({
      now: () => now, credentialTtlMs: 60_000, handshakeTimeoutMs: 10,
      maxFrameBytes: 4, maxSessions: 1,
    });
    hub.authorize("session", "a", "b", "room", ["client"]);
    hub.claim("a", "sender");
    now = 1_010;
    expect(hub.sweep()).toEqual([
      { sessionId: "session", roomCode: "room", connectionIds: ["sender"], reason: "RELAY_TIMEOUT" },
    ]);
    expect(hub.claim("b", "receiver")).toBeNull();
    expect(hub.sweep()).toEqual([]);
    expect(hub.authorize("replacement", "c", "d", "room", ["client"])).toBe(true);
  });

  test("paired sessions expire by idle time, not original credential TTL", () => {
    let now = 1_000;
    const hub = new RelayHub({
      now: () => now, credentialTtlMs: 20, idleTimeoutMs: 40, maxFrameBytes: 4,
    });
    hub.authorize("session", "a", "b");
    hub.claim("a", "sender");
    hub.claim("b", "receiver");
    now = 1_030;
    expect(hub.sweep()).toEqual([]);
    expect(hub.touch("sender")).toBe(true);
    now = 1_069;
    expect(hub.sweep()).toEqual([]);
    now = 1_070;
    expect(hub.sweep()[0]?.connectionIds).toEqual(["sender", "receiver"]);
  });
});
