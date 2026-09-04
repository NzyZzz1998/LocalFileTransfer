import { describe, expect, test } from "bun:test";
import nacl from "tweetnacl";

describe("relay application encryption", () => {
  test("exchanges ephemeral keys and authenticates text and binary frames", async () => {
    const { RelayCipher } = await import("../src/web/relay-crypto.js");
    const sender = new RelayCipher(nacl);
    const receiver = new RelayCipher(nacl);
    sender.acceptHello(receiver.createHello());
    receiver.acceptHello(sender.createHello());

    expect(receiver.open(sender.seal("manifest"))).toBe("manifest");
    expect(new Uint8Array(sender.open(receiver.seal(Uint8Array.from([1, 2, 3]).buffer)) as ArrayBuffer))
      .toEqual(Uint8Array.from([1, 2, 3]));
  });

  test("rejects tampering and replayed counters", async () => {
    const { RelayCipher } = await import("../src/web/relay-crypto.js");
    const sender = new RelayCipher(nacl);
    const receiver = new RelayCipher(nacl);
    sender.acceptHello(receiver.createHello());
    receiver.acceptHello(sender.createHello());
    const frame = sender.seal("secret");
    const tampered = frame.slice();
    tampered[tampered.length - 1] ^= 1;
    expect(() => receiver.open(tampered)).toThrow("authentication failed");
    expect(receiver.open(frame)).toBe("secret");
    expect(() => receiver.open(frame)).toThrow("replayed relay frame");
  });
});
