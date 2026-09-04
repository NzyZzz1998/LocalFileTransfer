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
});
