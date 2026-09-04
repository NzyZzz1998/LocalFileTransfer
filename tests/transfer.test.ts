import { describe, expect, test } from "bun:test";


type Listener = (event: { data?: unknown }) => void;

class FakeChannel {
  readonly sent: unknown[] = [];
  readyState = "open";
  binaryType = "blob";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  peer?: FakeChannel;
  private readonly listeners = new Map<string, Set<Listener>>();

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: unknown): void {
    this.sent.push(data);
    queueMicrotask(() => {
      if (!this.peer) return;
      const delivered =
        data instanceof ArrayBuffer && this.peer.binaryType === "blob" ? new Blob([data]) : data;
      this.peer.emit("message", { data: delivered });
    });
  }

  emit(type: string, event: { data?: unknown } = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  setBufferedAmount(amount: number): void {
    const wasAboveThreshold = this.bufferedAmount > this.bufferedAmountLowThreshold;
    this.bufferedAmount = amount;
    if (wasAboveThreshold && amount <= this.bufferedAmountLowThreshold) {
      this.emit("bufferedamountlow");
    }
  }
}

function channelPair(): [FakeChannel, FakeChannel] {
  const sender = new FakeChannel();
  const receiver = new FakeChannel();
  sender.peer = receiver;
  receiver.peer = sender;
  return [sender, receiver];
}

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(message);
}

function binaryMessages(channel: FakeChannel): ArrayBuffer[] {
  return channel.sent.filter((message): message is ArrayBuffer => message instanceof ArrayBuffer);
}

function controlMessages(channel: FakeChannel): Array<Record<string, unknown>> {
  return channel.sent
    .filter((message): message is string => typeof message === "string")
    .map((message) => JSON.parse(message));
}

function sendProtocolControl(channel: FakeChannel, message: Record<string, unknown>): void {
  channel.send(JSON.stringify({ v: 1, ...message }));
}

function deliverProtocolControl(channel: FakeChannel, message: Record<string, unknown>): void {
  channel.emit("message", { data: JSON.stringify({ v: 1, ...message }) });
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

interface SinkRecord {
  file: { id: string; name: string; size: number; mime: string };
  chunks: Uint8Array[];
  finalized: boolean;
  aborted: boolean;
}

function recordingSinkFactory(records: SinkRecord[]) {
  return async (file: SinkRecord["file"]) => {
    const record: SinkRecord = { file, chunks: [], finalized: false, aborted: false };
    records.push(record);
    return {
      get bytesWritten() {
        return record.chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
      },
      async write(chunk: Uint8Array) {
        record.chunks.push(chunk.slice());
      },
      async finalize() {
        record.finalized = true;
        return new Blob(record.chunks, { type: file.mime });
      },
      async abort() {
        record.aborted = true;
      },
    };
  };
}

function flatten(chunks: Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}


describe("browser transfer protocol", () => {
  test("configures the receiving channel to deliver binary chunks as ArrayBuffer", async () => {
    const { ReceiverEngine } = await import("../src/web/transfer.js");
    const channel = new FakeChannel();

    new ReceiverEngine(channel, {
      createSink: recordingSinkFactory([]),
    });

    expect(channel.binaryType).toBe("arraybuffer");
  });

  test("sends no file bytes before acceptance and sends none after rejection", async () => {
    const { ReceiverEngine, SenderEngine } = await import("../src/web/transfer.js");
    const [senderChannel, receiverChannel] = channelPair();
    const sender = new SenderEngine(senderChannel);
    const receiver = new ReceiverEngine(receiverChannel, {
      createSink: async () => {
        throw new Error("a rejected transfer must not create storage");
      },
    });

    const resultPromise = sender.send([
      new File([new Uint8Array([1, 2, 3])], "secret.bin"),
    ]);

    await waitUntil(() => receiver.state === "awaiting_acceptance", "manifest was not offered");
    expect(binaryMessages(senderChannel)).toHaveLength(0);

    receiver.reject();

    await expect(resultPromise).resolves.toEqual({ status: "rejected" });
    expect(binaryMessages(senderChannel)).toHaveLength(0);
    expect(sender.state).toBe("rejected");
    expect(receiver.state).toBe("rejected");
  });

  for (const fixture of [
    { size: 0, chunkLengths: [] },
    { size: 1, chunkLengths: [1] },
    { size: 16_384, chunkLengths: [16_384] },
    { size: 16_385, chunkLengths: [16_384, 1] },
  ]) {
    test(`transfers ${fixture.size} bytes in ordered 16 KiB chunks`, async () => {
      const { ReceiverEngine, SenderEngine } = await import("../src/web/transfer.js");
      const [senderChannel, receiverChannel] = channelPair();
      const records: SinkRecord[] = [];
      const sender = new SenderEngine(senderChannel);
      const receiver = new ReceiverEngine(receiverChannel, {
        createSink: recordingSinkFactory(records),
      });
      const source = Uint8Array.from(
        { length: fixture.size },
        (_, index) => (index * 31 + 7) % 256,
      );

      const resultPromise = sender.send([new File([source], "payload.bin")]);
      await waitUntil(() => receiver.state === "awaiting_acceptance", "manifest was not offered");
      receiver.accept();

      await expect(resultPromise).resolves.toEqual({
        status: "completed",
        files: 1,
        bytes: fixture.size,
      });
      expect(records).toHaveLength(1);
      expect(records[0].chunks.map((chunk) => chunk.byteLength)).toEqual(fixture.chunkLengths);
      expect(flatten(records[0].chunks)).toEqual(source);
      expect(records[0].finalized).toBe(true);
      expect(receiver.state).toBe("completed");
      expect(receiver.receivedFiles[0].sink).toBeDefined();
    });
  }

  test("starts the next file only after the previous file is finalized and confirmed", async () => {
    const { ReceiverEngine, SenderEngine } = await import("../src/web/transfer.js");
    const [senderChannel, receiverChannel] = channelPair();
    const firstFinalizeStarted = deferred();
    const releaseFirstFinalize = deferred();
    const received = new Map<string, number[]>();
    const sender = new SenderEngine(senderChannel);
    const receiver = new ReceiverEngine(receiverChannel, {
      createSink: async (file: { id: string }) => {
        const bytes: number[] = [];
        received.set(file.id, bytes);
        return {
          get bytesWritten() {
            return bytes.length;
          },
          async write(chunk: Uint8Array) {
            bytes.push(...chunk);
          },
          async finalize() {
            if (file.id === "file-0") {
              firstFinalizeStarted.resolve();
              await releaseFirstFinalize.promise;
            }
            return new Blob([Uint8Array.from(bytes)]);
          },
          async abort() {},
        };
      },
    });

    const resultPromise = sender.send([
      new File([Uint8Array.from([1, 2, 3])], "first.bin"),
      new File([Uint8Array.from([4, 5])], "second.bin"),
    ]);
    await waitUntil(() => receiver.state === "awaiting_acceptance", "manifest was not offered");
    receiver.accept();
    await firstFinalizeStarted.promise;

    expect(
      controlMessages(senderChannel).filter((message) => message.type === "file_start"),
    ).toEqual([
      expect.objectContaining({ fileId: "file-0" }),
    ]);

    releaseFirstFinalize.resolve();
    await expect(resultPromise).resolves.toEqual({ status: "completed", files: 2, bytes: 5 });
    expect(Array.from(received.entries())).toEqual([
      ["file-0", [1, 2, 3]],
      ["file-1", [4, 5]],
    ]);
    expect(receiver.receivedFiles.map(({ file }: { file: { id: string } }) => file.id)).toEqual([
      "file-0",
      "file-1",
    ]);
  });

  test("rejects and aborts a file whose received byte count is shorter than declared", async () => {
    const { ReceiverEngine } = await import("../src/web/transfer.js");
    const [remoteChannel, receiverChannel] = channelPair();
    const records: SinkRecord[] = [];
    const receiver = new ReceiverEngine(receiverChannel, {
      createSink: recordingSinkFactory(records),
    });

    sendProtocolControl(remoteChannel, {
      type: "offer_manifest",
      transferId: "truncated-transfer",
      files: [{ id: "file-0", name: "short.bin", size: 3, mime: "application/octet-stream" }],
    });
    await waitUntil(() => receiver.state === "awaiting_acceptance", "manifest was not offered");
    receiver.accept();
    sendProtocolControl(remoteChannel, {
      type: "file_start",
      transferId: "truncated-transfer",
      fileId: "file-0",
      size: 3,
    });
    remoteChannel.send(Uint8Array.from([1, 2]).buffer);
    sendProtocolControl(remoteChannel, {
      type: "file_end",
      transferId: "truncated-transfer",
      fileId: "file-0",
      sentBytes: 3,
    });

    await waitUntil(
      () => receiver.state === "failed" || receiver.state === "completed",
      "receiver did not reach a terminal state",
    );
    expect(receiver.state).toBe("failed");
    expect(records[0].aborted).toBe(true);
    expect(controlMessages(receiverChannel)).toContainEqual(
      expect.objectContaining({
        type: "error",
        transferId: "truncated-transfer",
        code: "BYTE_COUNT_MISMATCH",
      }),
    );
  });

  test("pauses binary chunks above the bufferedAmount high-water mark and resumes at low water", async () => {
    const { ReceiverEngine, SenderEngine } = await import("../src/web/transfer.js");
    const [senderChannel, receiverChannel] = channelPair();
    senderChannel.setBufferedAmount(32);
    const records: SinkRecord[] = [];
    const sender = new SenderEngine(senderChannel, {
      highWaterMark: 32,
      lowWaterMark: 8,
    });
    const receiver = new ReceiverEngine(receiverChannel, {
      createSink: recordingSinkFactory(records),
    });

    const resultPromise = sender.send([new File([Uint8Array.from([91])], "held.bin")]);
    await waitUntil(() => receiver.state === "awaiting_acceptance", "manifest was not offered");
    receiver.accept();
    await waitUntil(
      () => controlMessages(senderChannel).some((message) => message.type === "file_start"),
      "file did not enter the sending state",
    );

    expect(binaryMessages(senderChannel)).toHaveLength(0);

    senderChannel.setBufferedAmount(8);

    await expect(resultPromise).resolves.toEqual({ status: "completed", files: 1, bytes: 1 });
    expect(flatten(records[0].chunks)).toEqual(Uint8Array.from([91]));
  });

  test("reports manifest, state transitions, and sender/receiver byte progress", async () => {
    const { ReceiverEngine, SenderEngine } = await import("../src/web/transfer.js");
    const [senderChannel, receiverChannel] = channelPair();
    const senderStates: string[] = [];
    const receiverStates: string[] = [];
    const senderProgress: Array<Record<string, any>> = [];
    const receiverProgress: Array<Record<string, any>> = [];
    const manifests: Array<Record<string, any>> = [];
    const records: SinkRecord[] = [];
    const sender = new SenderEngine(senderChannel, {
      onState: (state: string) => senderStates.push(state),
      onProgress: (progress: Record<string, any>) => senderProgress.push(progress),
    });
    const receiver = new ReceiverEngine(receiverChannel, {
      createSink: recordingSinkFactory(records),
      onState: (state: string) => receiverStates.push(state),
      onManifest: (manifest: Record<string, any>) => manifests.push(manifest),
      onProgress: (progress: Record<string, any>) => receiverProgress.push(progress),
    });

    const resultPromise = sender.send([
      new File([new Uint8Array(16_385)], "progress.bin", {
        type: "application/octet-stream",
      }),
    ]);
    await waitUntil(() => receiver.state === "awaiting_acceptance", "manifest was not offered");

    expect(manifests).toHaveLength(1);
    expect(manifests[0].files).toEqual([
      expect.objectContaining({ id: "file-0", name: "progress.bin", size: 16_385 }),
    ]);

    receiver.accept();
    await resultPromise;

    expect(senderStates).toEqual(["awaiting_acceptance", "transferring", "completed"]);
    expect(receiverStates).toEqual(["awaiting_acceptance", "receiving", "completed"]);
    expect(senderProgress.map((progress) => progress.fileBytes)).toEqual([0, 16_384, 16_385]);
    expect(receiverProgress.map((progress) => progress.fileBytes)).toEqual([0, 16_384, 16_385]);
    expect(senderProgress.at(-1)).toMatchObject({
      file: expect.objectContaining({ name: "progress.bin" }),
      index: 0,
      fileBytes: 16_385,
      fileTotalBytes: 16_385,
      overallBytes: 16_385,
      totalBytes: 16_385,
    });
    expect(receiverProgress.at(-1)).toMatchObject({
      file: expect.objectContaining({ name: "progress.bin" }),
      index: 0,
      fileBytes: 16_385,
      fileTotalBytes: 16_385,
      overallBytes: 16_385,
      totalBytes: 16_385,
    });
  });

  test("does not complete the sender until the receiver confirms the whole transfer", async () => {
    const { SenderEngine } = await import("../src/web/transfer.js");
    const channel = new FakeChannel();
    const sender = new SenderEngine(channel);
    let settled = false;

    const resultPromise = sender.send([new File([Uint8Array.from([8])], "confirm.bin")]);
    resultPromise.then(() => {
      settled = true;
    });
    const offer = controlMessages(channel).find((message) => message.type === "offer_manifest")!;
    deliverProtocolControl(channel, {
      type: "accept_manifest",
      transferId: offer.transferId,
    });
    await waitUntil(
      () => controlMessages(channel).some((message) => message.type === "file_end"),
      "file was not sent",
    );
    deliverProtocolControl(channel, {
      type: "file_received",
      transferId: offer.transferId,
      fileId: "file-0",
      receivedBytes: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(settled).toBe(false);
    expect(sender.state).toBe("transferring");

    deliverProtocolControl(channel, {
      type: "transfer_complete",
      transferId: offer.transferId,
    });
    await expect(resultPromise).resolves.toEqual({ status: "completed", files: 1, bytes: 1 });
  });

  test("cancels an offered transfer on both peers without sending file bytes", async () => {
    const { ReceiverEngine, SenderEngine } = await import("../src/web/transfer.js");
    const [senderChannel, receiverChannel] = channelPair();
    const sender = new SenderEngine(senderChannel);
    const receiver = new ReceiverEngine(receiverChannel, {
      createSink: recordingSinkFactory([]),
    });
    const resultPromise = sender.send([
      new File([Uint8Array.from([1, 2, 3])], "cancelled.bin"),
    ]);
    await waitUntil(() => receiver.state === "awaiting_acceptance", "manifest was not offered");

    sender.cancel();

    await expect(resultPromise).resolves.toEqual({ status: "cancelled" });
    await waitUntil(() => receiver.state === "cancelled", "receiver was not cancelled");
    expect(binaryMessages(senderChannel)).toHaveLength(0);
  });

  test("receiver cancellation stops a sender paused by backpressure", async () => {
    const { ReceiverEngine, SenderEngine } = await import("../src/web/transfer.js");
    const [senderChannel, receiverChannel] = channelPair();
    senderChannel.setBufferedAmount(32);
    const sender = new SenderEngine(senderChannel, { highWaterMark: 32, lowWaterMark: 8 });
    const receiver = new ReceiverEngine(receiverChannel, {
      createSink: recordingSinkFactory([]),
    });
    const resultPromise = sender.send([
      new File([new Uint8Array(16_385)], "paused.bin"),
    ]);
    await waitUntil(() => receiver.state === "awaiting_acceptance", "manifest was not offered");
    receiver.accept();
    await waitUntil(
      () => controlMessages(senderChannel).some((message) => message.type === "file_start"),
      "file did not start",
    );

    await receiver.cancel();
    await expect(resultPromise).resolves.toEqual({ status: "cancelled" });
    senderChannel.setBufferedAmount(8);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sender.state).toBe("cancelled");
    expect(binaryMessages(senderChannel)).toHaveLength(0);
  });

  test("rejects an invalid manifest before allocating browser storage", async () => {
    const { ReceiverEngine } = await import("../src/web/transfer.js");
    const [remoteChannel, receiverChannel] = channelPair();
    let storageCalls = 0;
    const receiver = new ReceiverEngine(receiverChannel, {
      createSink: async () => {
        storageCalls += 1;
        return recordingSinkFactory([])({
          id: "file-0",
          name: "bad.bin",
          size: 0,
          mime: "application/octet-stream",
        });
      },
    });

    sendProtocolControl(remoteChannel, {
      type: "offer_manifest",
      transferId: "malicious",
      files: [{ id: "file-0", name: "bad.bin", size: -1, mime: "application/octet-stream" }],
    });
    await waitUntil(() => receiver.state === "failed", "invalid manifest was not rejected");

    expect(storageCalls).toBe(0);
    expect(controlMessages(receiverChannel)).toContainEqual(
      expect.objectContaining({ type: "error", code: "INVALID_MANIFEST" }),
    );
  });

  test("local cancellation still settles when the data channel is already closed", async () => {
    const { SenderEngine } = await import("../src/web/transfer.js");
    const channel = new FakeChannel();
    const sender = new SenderEngine(channel);
    const resultPromise = sender.send([new File([Uint8Array.of(1)], "closed.bin")]);
    channel.send = () => {
      throw new Error("channel is closed");
    };

    expect(() => sender.cancel()).not.toThrow();
    await expect(resultPromise).resolves.toEqual({ status: "cancelled" });
    expect(sender.state).toBe("cancelled");
  });

  test("a data-channel close fails an active sender instead of leaving it pending", async () => {
    const { SenderEngine } = await import("../src/web/transfer.js");
    const channel = new FakeChannel();
    const sender = new SenderEngine(channel);
    const resultPromise = sender.send([new File([Uint8Array.of(1)], "pending.bin")]);

    channel.emit("close");

    expect(sender.state).toBe("failed");
    await expect(resultPromise).rejects.toThrow("data channel closed");
  });

  test("a data-channel close aborts an active receiver sink", async () => {
    const { ReceiverEngine } = await import("../src/web/transfer.js");
    const [remoteChannel, receiverChannel] = channelPair();
    const records: SinkRecord[] = [];
    const receiver = new ReceiverEngine(receiverChannel, {
      createSink: recordingSinkFactory(records),
    });

    sendProtocolControl(remoteChannel, {
      type: "offer_manifest",
      transferId: "interrupted",
      files: [
        {
          id: "file-0",
          name: "partial.bin",
          size: 4,
          mime: "application/octet-stream",
        },
      ],
    });
    await waitUntil(() => receiver.state === "awaiting_acceptance", "manifest was not offered");
    receiver.accept();
    sendProtocolControl(remoteChannel, {
      type: "file_start",
      transferId: "interrupted",
      fileId: "file-0",
      size: 4,
    });
    await waitUntil(() => records.length === 1, "receiver sink was not created");

    receiverChannel.emit("close");

    await waitUntil(() => receiver.state === "failed", "receiver did not fail after close");
    expect(records[0].aborted).toBe(true);
  });

  test("a sender read failure notifies the receiver and aborts its partial sink", async () => {
    const { ReceiverEngine, SenderEngine } = await import("../src/web/transfer.js");
    const [senderChannel, receiverChannel] = channelPair();
    const records: SinkRecord[] = [];
    const sender = new SenderEngine(senderChannel);
    const receiver = new ReceiverEngine(receiverChannel, {
      createSink: recordingSinkFactory(records),
    });
    const unreadable = new File([Uint8Array.of(1, 2, 3, 4)], "unreadable.bin");
    unreadable.slice = () =>
      ({ arrayBuffer: async () => Promise.reject(new Error("local read failed")) }) as Blob;

    const resultPromise = sender.send([unreadable]);
    await waitUntil(() => receiver.state === "awaiting_acceptance", "manifest was not offered");
    receiver.accept();

    await expect(resultPromise).rejects.toThrow("local read failed");
    await waitUntil(() => receiver.state === "failed", "receiver was not notified");
    expect(records).toHaveLength(1);
    expect(records[0].aborted).toBe(true);
  });

  test("a sender failure releases its internal receipt wait", async () => {
    const { SenderEngine } = await import("../src/web/transfer.js");
    const channel = new FakeChannel();
    const sender = new SenderEngine(channel);
    const resultPromise = sender.send([new File([], "empty.bin")]);
    const offer = controlMessages(channel).find((message) => message.type === "offer_manifest")!;
    deliverProtocolControl(channel, {
      type: "accept_manifest",
      transferId: offer.transferId,
    });
    await waitUntil(() => Boolean(sender.fileReceived), "sender did not wait for a receipt");

    channel.emit("close");

    await expect(resultPromise).rejects.toThrow("data channel closed");
    const released = await Promise.race([
      sender.fileReceived.promise.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20)),
    ]);
    expect(released).toBe(true);
  });

  test("receiver cancellation stays terminal when a channel close races with sink abort", async () => {
    const { ReceiverEngine } = await import("../src/web/transfer.js");
    const [remoteChannel, receiverChannel] = channelPair();
    const abortGate = deferred();
    let abortCalls = 0;
    const receiver = new ReceiverEngine(receiverChannel, {
      createSink: async () => ({
        bytesWritten: 0,
        async write() {},
        async finalize() {
          return new Blob();
        },
        async abort() {
          abortCalls += 1;
          await abortGate.promise;
        },
      }),
    });
    sendProtocolControl(remoteChannel, {
      type: "offer_manifest",
      transferId: "cancel-close-race",
      files: [
        {
          id: "file-0",
          name: "partial.bin",
          size: 4,
          mime: "application/octet-stream",
        },
      ],
    });
    await waitUntil(() => receiver.state === "awaiting_acceptance", "manifest was not offered");
    receiver.accept();
    sendProtocolControl(remoteChannel, {
      type: "file_start",
      transferId: "cancel-close-race",
      fileId: "file-0",
      size: 4,
    });
    await waitUntil(() => Boolean(receiver.currentFile), "receiver sink was not created");

    const cancellation = receiver.cancel();
    receiverChannel.emit("close");
    await new Promise((resolve) => setTimeout(resolve, 0));
    abortGate.resolve();
    await cancellation;
    await receiver.processing;

    expect(abortCalls).toBe(1);
    expect(receiver.state).toBe("cancelled");
  });
});
