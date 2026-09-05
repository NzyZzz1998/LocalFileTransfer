import { afterEach, describe, expect, test } from "bun:test";
import nacl from "tweetnacl";
import { RelayTransport } from "../src/web/relay-transport.js";
import { ReceiverEngine, SenderEngine } from "../src/web/transfer.js";

class FakeRelayWebSocket {
  static instances: FakeRelayWebSocket[] = [];
  readyState = 0;
  binaryType = "blob";
  bufferedAmount = 0;
  sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event?: { code?: number; reason?: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closeCalls = 0;
  constructor(public url: string) { FakeRelayWebSocket.instances.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  receive(data: unknown) { this.onmessage?.({ data }); }
  send(data: unknown) { this.sent.push(data); }
  close() { this.closeCalls += 1; this.readyState = 3; this.onclose?.(); }
  remoteClose(code = 1006, reason = "") { this.readyState = 3; this.onclose?.({ code, reason }); }
}

class FakeTimers {
  nextId = 1;
  pending = new Map<number, { callback: () => void; delay: number }>();
  set = (callback: () => void, delay: number) => {
    const id = this.nextId++;
    this.pending.set(id, { callback, delay });
    return id;
  };
  clear = (id: number) => { this.pending.delete(id); };
  runNext() {
    const entry = this.pending.entries().next().value;
    if (!entry) throw new Error("no timer scheduled");
    this.pending.delete(entry[0]);
    entry[1].callback();
  }
}

const transports: RelayTransport[] = [];
function makeTransport(options: Record<string, unknown> = {}) {
  const transport = new RelayTransport({
    token: "one-time token",
    WebSocketImpl: FakeRelayWebSocket,
    location: { protocol: "http:", host: "dukoutest.local" },
    naclImpl: nacl,
    ...options,
  });
  transports.push(transport);
  return transport;
}

async function connectPair(options: Record<string, unknown> = {}) {
  FakeRelayWebSocket.instances = [];
  const sender = makeTransport(options);
  const receiver = makeTransport(options);
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
  return { sender, receiver, senderSocket, receiverSocket };
}

afterEach(() => {
  for (const transport of transports.splice(0)) transport.close();
  FakeRelayWebSocket.instances = [];
});

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
    sender.close();
    receiver.close();
  });

  test.each(["tamper", "replay"])("%s closes once, fails an active receiver, and aborts its sink", async (kind) => {
    const { sender, receiver, receiverSocket } = await connectPair();
    let aborted = 0;
    let closes = 0;
    let errors = 0;
    receiver.addEventListener("close", () => { closes += 1; });
    receiver.addEventListener("error", () => { errors += 1; });
    const engine = new ReceiverEngine(receiver, {
      createSink: async () => ({
        write: async () => {},
        abort: async () => { aborted += 1; },
      }),
    });
    const transferId = "authenticated-transfer";
    const control = (message: Record<string, unknown>) => receiverSocket.receive(sender.cipher.seal(JSON.stringify({ v: 1, transferId, ...message })));
    control({ type: "offer_manifest", files: [{ id: "file-0", name: "safe.bin", size: 4, mime: "application/octet-stream" }] });
    await engine.processing;
    engine.accept();
    control({ type: "file_start", fileId: "file-0", size: 4 });
    await engine.processing;
    const frame = sender.cipher.seal(new Uint8Array([1, 2]).buffer);
    if (kind === "replay") {
      receiverSocket.receive(frame);
      await engine.processing;
    } else {
      frame[frame.length - 1] ^= 1;
    }
    const sharedKey = receiver.cipher.sharedKey;
    receiverSocket.receive(frame);
    await engine.processing;
    receiver.close();
    receiverSocket.remoteClose();
    expect(receiver.readyState).toBe("closed");
    expect(engine.state).toBe("failed");
    expect(aborted).toBe(1);
    expect(closes).toBe(1);
    expect(errors).toBe(1);
    expect(sharedKey?.every((byte: number) => byte === 0)).toBe(true);
    expect(receiver.cipher.sharedKey).toBeNull();
    expect(receiver.pendingMessages).toHaveLength(0);
    expect(receiver.listeners.size).toBe(0);
  });

  test("authentication failure rejects an awaiting sender instead of leaving its result pending", async () => {
    const { sender, receiver, senderSocket } = await connectPair();
    const engine = new SenderEngine(sender);
    const result = engine.send([new File(["secret"], "secret.txt")]).catch((error: Error) => error);
    const frame = receiver.cipher.seal("tampered");
    frame[frame.length - 1] ^= 1;
    senderSocket.receive(frame);
    expect(engine.state).toBe("failed");
    expect(await result).toBeInstanceOf(Error);
  });

  test("close during key exchange immediately rejects connect and clears all resources once", async () => {
    const timers = new FakeTimers();
    const transport = makeTransport({ setTimeoutImpl: timers.set, clearTimeoutImpl: timers.clear });
    let closes = 0;
    transport.addEventListener("close", () => { closes += 1; });
    const result = transport.connect().catch((error: Error & { code: string }) => error);
    const socket = FakeRelayWebSocket.instances.at(-1)!;
    transport.close();
    transport.close();
    const error = await result;
    expect(error.code).toBe("RELAY_CANCELLED");
    expect(closes).toBe(1);
    expect(socket.closeCalls).toBe(1);
    expect(timers.pending.size).toBe(0);
    expect(transport.token).toBeUndefined();
    expect(transport.cipher.keyPair.secretKey.every((byte: number) => byte === 0)).toBe(true);
    expect(transport.listeners.size).toBe(0);
    expect(socket.onmessage).toBeNull();
  });

  test("an aborted signal never opens a socket, and a live signal cancels a pending handshake", async () => {
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();
    const before = FakeRelayWebSocket.instances.length;
    const aborted = makeTransport();
    await expect(aborted.connect({ signal: alreadyAborted.signal })).rejects.toMatchObject({ code: "RELAY_CANCELLED" });
    expect(FakeRelayWebSocket.instances.length).toBe(before);

    const controller = new AbortController();
    const transport = makeTransport();
    const result = transport.connect({ signal: controller.signal }).catch((error: Error & { code: string }) => error);
    controller.abort();
    expect((await result).code).toBe("RELAY_CANCELLED");
    expect(transport.readyState).toBe("closed");
  });

  test("the session signal also closes an established transport", async () => {
    const controller = new AbortController();
    const sender = makeTransport();
    const receiver = makeTransport();
    const senderReady = sender.connect({ signal: controller.signal });
    const receiverReady = receiver.connect();
    const [senderSocket, receiverSocket] = FakeRelayWebSocket.instances;
    senderSocket.open(); receiverSocket.open();
    senderSocket.receive(JSON.stringify({ type: "relay_open" }));
    receiverSocket.receive(JSON.stringify({ type: "relay_open" }));
    senderSocket.receive(receiverSocket.sent[0]);
    receiverSocket.receive(senderSocket.sent[0]);
    await Promise.all([senderReady, receiverReady]);
    let closes = 0;
    sender.addEventListener("close", () => { closes += 1; });
    controller.abort();
    expect(sender.readyState).toBe("closed");
    expect(closes).toBe(1);
  });

  test("handshake timeout is bounded and a late key hello cannot reopen the transport", async () => {
    const timers = new FakeTimers();
    const transport = makeTransport({ setTimeoutImpl: timers.set, clearTimeoutImpl: timers.clear });
    const result = transport.connect().catch((error: Error & { code: string }) => error);
    const socket = FakeRelayWebSocket.instances.at(-1)!;
    const staleHandler = socket.onmessage!;
    expect([...timers.pending.values()].map((timer) => timer.delay)).toEqual([20_000]);
    timers.runNext();
    expect((await result).code).toBe("RELAY_TIMEOUT");
    staleHandler({ data: transport.cipher.createHello() });
    expect(transport.readyState).toBe("closed");
    expect(timers.pending.size).toBe(0);
    expect(socket.closeCalls).toBe(1);
  });

  test("socket errors and server close reasons terminate once with an actionable code", async () => {
    const transport = makeTransport();
    const result = transport.connect().catch((error: Error & { code: string }) => error);
    const socket = FakeRelayWebSocket.instances.at(-1)!;
    let closes = 0;
    let errors = 0;
    transport.addEventListener("close", () => { closes += 1; });
    transport.addEventListener("error", () => { errors += 1; });
    socket.onerror?.();
    socket.remoteClose();
    expect((await result).code).toBe("RELAY_UNAVAILABLE");
    expect(closes).toBe(1);
    expect(errors).toBe(1);

    const { receiver, receiverSocket } = await connectPair();
    let terminalCode;
    receiver.addEventListener("close", (event: { code: string }) => { terminalCode = event.code; });
    receiverSocket.remoteClose(1008, "RELAY_LIMIT");
    expect(terminalCode).toBe("RELAY_LIMIT");
  });

  test("prelistener frames drain in order to current listeners, and close cancels queued delivery", async () => {
    const { sender, receiver, receiverSocket } = await connectPair();
    receiverSocket.receive(sender.cipher.seal("first"));
    const removed: unknown[] = [];
    const firstListener = (event: { data: unknown }) => { removed.push(event.data); };
    receiver.addEventListener("message", firstListener);
    receiver.removeEventListener("message", firstListener);
    const received: unknown[] = [];
    receiver.addEventListener("message", (event: { data: unknown }) => { received.push(event.data); });
    receiverSocket.receive(sender.cipher.seal("second"));
    await Promise.resolve();
    expect(removed).toEqual([]);
    expect(received).toEqual(["first", "second"]);
    expect(receiver.pendingMessages).toHaveLength(0);
    expect(receiver.pendingMessageBytes).toBe(0);

    const other = await connectPair();
    other.receiverSocket.receive(other.sender.cipher.seal("discard"));
    let deliveries = 0;
    other.receiver.addEventListener("message", () => { deliveries += 1; });
    other.receiver.close();
    await Promise.resolve();
    expect(deliveries).toBe(0);
    expect(other.receiver.pendingMessages).toHaveLength(0);
    expect(other.receiver.pendingMessageBytes).toBe(0);
  });

  test.each([
    { maxPendingMessages: 2, maxPendingBytes: 1024, values: ["", "", ""] },
    { maxPendingMessages: 64, maxPendingBytes: 4, values: ["hello"] },
  ])("prelistener queue closes deterministically at its count or byte limit", async ({ values, ...options }) => {
    const { sender, receiver, receiverSocket } = await connectPair(options);
    let code;
    receiver.addEventListener("close", (event: { code: string }) => { code = event.code; });
    for (const value of values) receiverSocket.receive(sender.cipher.seal(value));
    expect(receiver.readyState).toBe("closed");
    expect(code).toBe("RELAY_LIMIT");
    expect(receiver.pendingMessages).toHaveLength(0);
    expect(receiver.pendingMessageBytes).toBe(0);
  });

  test("repeated sends share one drain timer, dispatch low once, and cancel polling on close", async () => {
    const timers = new FakeTimers();
    const { sender, senderSocket } = await connectPair({ setTimeoutImpl: timers.set, clearTimeoutImpl: timers.clear });
    sender.bufferedAmountLowThreshold = 10;
    senderSocket.bufferedAmount = 20;
    let lowEvents = 0;
    sender.addEventListener("bufferedamountlow", () => { lowEvents += 1; });
    for (let index = 0; index < 10; index += 1) sender.send("chunk");
    expect(timers.pending.size).toBe(1);
    timers.runNext();
    expect(timers.pending.size).toBe(1);
    senderSocket.bufferedAmount = 0;
    timers.runNext();
    expect(lowEvents).toBe(1);
    expect(timers.pending.size).toBe(0);
    senderSocket.bufferedAmount = 20;
    sender.send("last");
    sender.close();
    expect(timers.pending.size).toBe(0);
  });

  test("a consumer exception is reported independently and cannot masquerade as crypto failure", async () => {
    const reported: Error[] = [];
    const { sender, receiver, receiverSocket } = await connectPair({ reportErrorImpl: (error: Error) => reported.push(error) });
    const consumerError = new Error("consumer failed");
    receiver.addEventListener("message", () => { throw consumerError; });
    let received;
    receiver.addEventListener("message", (event: { data: unknown }) => { received = event.data; });
    receiverSocket.receive(sender.cipher.seal("valid"));
    expect(receiver.readyState).toBe("open");
    expect(received).toBe("valid");
    expect(reported).toEqual([consumerError]);
  });

  test("socket construction failure rejects connect and destroys the unused key pair", async () => {
    class UnavailableSocket {
      constructor() { throw new Error("socket disabled"); }
    }
    const timers = new FakeTimers();
    const transport = makeTransport({ WebSocketImpl: UnavailableSocket, setTimeoutImpl: timers.set, clearTimeoutImpl: timers.clear });
    await expect(transport.connect()).rejects.toMatchObject({ code: "RELAY_UNAVAILABLE" });
    expect(transport.readyState).toBe("closed");
    expect(transport.cipher.keyPair.secretKey.every((byte: number) => byte === 0)).toBe(true);
    expect(transport.token).toBeUndefined();
    expect(timers.pending.size).toBe(0);
  });

  test("never delivers plaintext application frames or starts without cryptography", async () => {
    expect(() => makeTransport({ naclImpl: null })).toThrow("cryptography unavailable");
    const { receiver, receiverSocket } = await connectPair();
    let deliveries = 0;
    receiver.addEventListener("message", () => { deliveries += 1; });
    receiverSocket.receive(JSON.stringify({ v: 1, type: "offer_manifest", files: [] }));
    expect(receiver.readyState).toBe("closed");
    expect(receiver.terminalError.code).toBe("RELAY_AUTH_FAILED");
    expect(deliveries).toBe(0);
  });
});
