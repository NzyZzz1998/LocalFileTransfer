import { describe, expect, test } from "bun:test";
import nacl from "tweetnacl";

class FakeRelayWebSocket {
  static instances: FakeRelayWebSocket[] = [];
  readyState = 0;
  binaryType = "blob";
  bufferedAmount = 0;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) { FakeRelayWebSocket.instances.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  receive(data: unknown) { this.onmessage?.({ data }); }
  send(data: unknown) { this.sent.push(data); }
  close() { this.readyState = 3; this.onclose?.(); }
}

describe("RelayTransport", () => {
  test("becomes a DataChannel-like encrypted transport after both key hellos", async () => {
    const { RelayTransport } = await import("../src/web/relay-transport.js");
    FakeRelayWebSocket.instances = [];
    const sender = new RelayTransport({
      token: "sender token",
      WebSocketImpl: FakeRelayWebSocket,
      location: { protocol: "http:", host: "dukoutest.local" },
      naclImpl: nacl,
    });
    const receiver = new RelayTransport({
      token: "receiver token",
      WebSocketImpl: FakeRelayWebSocket,
      location: { protocol: "http:", host: "dukoutest.local" },
      naclImpl: nacl,
    });
    const senderReady = sender.connect();
    const receiverReady = receiver.connect();
    const [senderSocket, receiverSocket] = FakeRelayWebSocket.instances;
    senderSocket.open();
    receiverSocket.open();
    senderSocket.receive(JSON.stringify({ type: "relay_open" }));
    receiverSocket.receive(JSON.stringify({ type: "relay_open" }));
    receiverSocket.receive(senderSocket.sent[0]);
    senderSocket.receive(receiverSocket.sent[0]);
    await Promise.all([senderReady, receiverReady]);
    expect(sender.readyState).toBe("open");
    expect(senderSocket.url).toBe("ws://dukoutest.local/relay?token=sender%20token");

    const received = new Promise<unknown>((resolve) => receiver.addEventListener("message", (event: any) => resolve(event.data)));
    sender.send("manifest");
    receiverSocket.receive(senderSocket.sent[1]);
    expect(await received).toBe("manifest");
  });
});
