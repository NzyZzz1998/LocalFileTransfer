export const TRANSFER_PROTOCOL_VERSION = 1;
export const TRANSFER_CHUNK_BYTES = 16 * 1024;
const DEFAULT_HIGH_WATER_MARK = 4 * 1024 * 1024;
const DEFAULT_LOW_WATER_MARK = 1024 * 1024;
const ACK_INTERVAL_BYTES = 256 * 1024;

let nextTransferNumber = 1;

export class TransferMetrics {
  constructor(now = () => performance.now()) {
    this.now = now;
    this.startedAt = null;
    this.samples = [];
    this.lastBytes = 0;
  }

  update(bytes, totalBytes) {
    const at = this.now();
    if (this.startedAt === null || bytes < this.lastBytes) {
      this.startedAt = at;
      this.samples = [{ at, bytes }];
    } else {
      this.samples.push({ at, bytes });
    }
    this.lastBytes = bytes;
    const cutoff = at - 2_000;
    while (this.samples.length > 2 && this.samples[1].at <= cutoff) this.samples.shift();
    const first = this.samples[0];
    const windowMs = at - first.at;
    const elapsedMs = at - this.startedAt;
    const currentBytesPerSecond = windowMs > 0 ? ((bytes - first.bytes) * 1_000) / windowMs : 0;
    const averageBytesPerSecond = elapsedMs > 0 ? (bytes * 1_000) / elapsedMs : 0;
    const etaMs =
      elapsedMs >= 1_000 && averageBytesPerSecond > 0
        ? ((Math.max(0, totalBytes - bytes) / averageBytesPerSecond) * 1_000)
        : null;
    return { currentBytesPerSecond, averageBytesPerSecond, elapsedMs, etaMs };
  }
}

function sendControl(channel, message) {
  channel.send(JSON.stringify({ v: TRANSFER_PROTOCOL_VERSION, ...message }));
}

function readControl(data) {
  if (typeof data !== "string") return undefined;
  try {
    const message = JSON.parse(data);
    if (message?.v !== TRANSFER_PROTOCOL_VERSION || typeof message.type !== "string") {
      return undefined;
    }
    return message;
  } catch {
    return undefined;
  }
}

function isValidManifest(message) {
  if (
    typeof message.transferId !== "string" ||
    message.transferId.length < 1 ||
    message.transferId.length > 64 ||
    !Array.isArray(message.files) ||
    message.files.length < 1 ||
    message.files.length > 1_000
  ) {
    return false;
  }
  const ids = new Set();
  let totalBytes = 0;
  for (const file of message.files) {
    if (
      !file ||
      typeof file !== "object" ||
      typeof file.id !== "string" ||
      file.id.length < 1 ||
      file.id.length > 64 ||
      ids.has(file.id) ||
      typeof file.name !== "string" ||
      file.name.length < 1 ||
      file.name.length > 255 ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      typeof file.mime !== "string" ||
      file.mime.length > 255
    ) {
      return false;
    }
    ids.add(file.id);
    totalBytes += file.size;
    if (!Number.isSafeInteger(totalBytes)) return false;
  }
  return true;
}

function listen(channel, type, listener) {
  channel.addEventListener(type, listener);
  return () => channel.removeEventListener(type, listener);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class TransferProtocolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TransferProtocolError";
    this.code = code;
  }
}

export class SenderEngine {
  state = "idle";

  constructor(
    channel,
    {
      highWaterMark = DEFAULT_HIGH_WATER_MARK,
      lowWaterMark = DEFAULT_LOW_WATER_MARK,
      onProgress = () => {},
      onState = () => {},
    } = {},
  ) {
    this.channel = channel;
    this.highWaterMark = highWaterMark;
    this.lowWaterMark = lowWaterMark;
    this.onProgress = onProgress;
    this.onState = onState;
    this.channel.bufferedAmountLowThreshold = lowWaterMark;
    this.removeMessageListener = listen(channel, "message", (event) => {
      this.handleMessage(event.data);
    });
    this.removeCloseListener = listen(channel, "close", () => {
      if (this.state !== "idle") this.fail(new Error("data channel closed"));
    });
  }

  send(files) {
    if (this.state !== "idle") throw new Error("sender is already in a transfer");

    this.files = Array.from(files);
    this.manifestFiles = this.files.map((file, index) => ({
      id: `file-${index}`,
      name: file.name,
      size: file.size,
      mime: file.type || "application/octet-stream",
    }));
    this.totalBytes = this.manifestFiles.reduce((total, file) => total + file.size, 0);
    this.transferId = `transfer-${nextTransferNumber++}`;
    this.setState("awaiting_acceptance");
    this.result = new Promise((resolve, reject) => {
      this.resolveResult = resolve;
      this.rejectResult = reject;
    });
    this.transferCompleted = deferred();
    this.sentOverallBytes = 0;
    this.acknowledgedOverallBytes = 0;

    sendControl(this.channel, {
      type: "offer_manifest",
      transferId: this.transferId,
      files: this.manifestFiles,
    });

    return this.result;
  }

  handleMessage(data) {
    const message = readControl(data);
    if (message?.type === "cancel" && message.transferId === this.transferId) {
      this.finishCancelled();
      return;
    }
    if (
      message?.type === "reject_manifest" &&
      message.transferId === this.transferId &&
      this.state === "awaiting_acceptance"
    ) {
      this.setState("rejected");
      this.resolveResult({ status: "rejected" });
      return;
    }

    if (
      message?.type === "accept_manifest" &&
      message.transferId === this.transferId &&
      this.state === "awaiting_acceptance"
    ) {
      this.setState("transferring");
      this.transmitFiles().catch((error) => this.fail(error));
      return;
    }

    if (message?.type === "file_received" && message.transferId === this.transferId) {
      this.fileReceived?.resolve(message);
      return;
    }

    if (message?.type === "transfer_ack" && message.transferId === this.transferId) {
      const valid =
        this.state === "transferring" &&
        message.fileId === `file-${this.currentFileIndex}` &&
        Number.isSafeInteger(message.receivedBytes) &&
        Number.isSafeInteger(message.overallBytes) &&
        message.receivedBytes >= 0 &&
        message.overallBytes >= this.acknowledgedOverallBytes &&
        message.overallBytes <= this.sentOverallBytes &&
        message.overallBytes === this.completedFileBytes + message.receivedBytes;
      if (!valid) {
        this.fail(new TransferProtocolError("INVALID_ACK", "invalid receiver acknowledgement"));
        return;
      }
      this.acknowledgedOverallBytes = message.overallBytes;
      this.reportProgress(
        this.manifestFiles[this.currentFileIndex],
        this.currentFileIndex,
        message.receivedBytes,
        message.overallBytes,
      );
      return;
    }

    if (message?.type === "transfer_complete" && message.transferId === this.transferId) {
      this.transferCompleted.resolve(message);
      return;
    }

    if (message?.type === "error" && message.transferId === this.transferId) {
      this.fail(new Error(message.code || "remote transfer error"));
    }
  }

  async transmitFiles() {
    let totalBytes = 0;
    for (let index = 0; index < this.files.length; index += 1) {
      if (this.state !== "transferring") return;
      const file = this.files[index];
      const fileMetadata = this.manifestFiles[index];
      const fileId = `file-${index}`;
      this.currentFileIndex = index;
      this.completedFileBytes = totalBytes;
      this.fileReceived = deferred();
      this.reportProgress(fileMetadata, index, 0, totalBytes);
      sendControl(this.channel, {
        type: "file_start",
        transferId: this.transferId,
        fileId,
        size: file.size,
      });

      for (let offset = 0; offset < file.size; offset += TRANSFER_CHUNK_BYTES) {
        const chunk = await file
          .slice(offset, Math.min(file.size, offset + TRANSFER_CHUNK_BYTES))
          .arrayBuffer();
        if (this.state !== "transferring") return;
        await this.waitForWritableBuffer();
        if (this.state !== "transferring") return;
        this.channel.send(chunk);
        const fileBytes = Math.min(file.size, offset + chunk.byteLength);
        this.sentOverallBytes = totalBytes + fileBytes;
      }

      if (this.state !== "transferring") return;

      sendControl(this.channel, {
        type: "file_end",
        transferId: this.transferId,
        fileId,
        sentBytes: file.size,
      });

      const receipt = await this.fileReceived.promise;
      if (this.state !== "transferring") return;
      if (receipt.fileId !== fileId || receipt.receivedBytes !== file.size) {
        throw new Error("receiver byte count did not match the file");
      }
      totalBytes += file.size;
      this.acknowledgedOverallBytes = totalBytes;
    }
    await this.transferCompleted.promise;
    if (this.state !== "transferring") return;

    this.setState("completed");
    this.resolveResult({ status: "completed", files: this.files.length, bytes: totalBytes });
  }

  reportProgress(file, index, fileBytes, overallBytes) {
    this.onProgress({
      file,
      index,
      fileBytes,
      fileTotalBytes: file.size,
      overallBytes,
      totalBytes: this.totalBytes,
    });
  }

  setState(state) {
    this.state = state;
    this.onState(state);
  }

  async waitForWritableBuffer() {
    if (this.channel.bufferedAmount < this.highWaterMark) return;

    await new Promise((resolve, reject) => {
      const cleanup = () => {
        this.channel.removeEventListener("bufferedamountlow", handleLow);
        this.channel.removeEventListener("close", handleClose);
      };
      const handleLow = () => {
        if (this.channel.bufferedAmount > this.lowWaterMark) return;
        cleanup();
        resolve();
      };
      const handleClose = () => {
        cleanup();
        reject(new Error("data channel closed while waiting for buffer space"));
      };

      this.channel.addEventListener("bufferedamountlow", handleLow);
      this.channel.addEventListener("close", handleClose);
      if (this.channel.bufferedAmount <= this.lowWaterMark) handleLow();
    });
  }

  cancel() {
    if (["completed", "rejected", "cancelled", "failed"].includes(this.state)) return;
    try {
      sendControl(this.channel, {
        type: "cancel",
        transferId: this.transferId,
        reason: "user",
      });
    } catch {
      // Local cleanup must still finish after a transport-level close.
    }
    this.finishCancelled();
  }

  finishCancelled() {
    if (["completed", "rejected", "cancelled", "failed"].includes(this.state)) return;
    this.setState("cancelled");
    this.fileReceived?.resolve({ type: "cancel" });
    this.transferCompleted?.resolve({ type: "cancel" });
    this.resolveResult?.({ status: "cancelled" });
  }

  fail(error) {
    if (["completed", "rejected", "cancelled", "failed"].includes(this.state)) return;
    this.setState("failed");
    try {
      sendControl(this.channel, {
        type: "error",
        transferId: this.transferId,
        code: error?.code || "SENDER_FAILED",
      });
    } catch {
      // The peer will learn about a transport close through its channel listener.
    }
    this.fileReceived?.resolve({ type: "error" });
    this.transferCompleted?.resolve({ type: "error" });
    this.rejectResult?.(error);
  }
}

export class ReceiverEngine {
  state = "idle";

  constructor(
    channel,
    {
      createSink,
      onManifest = () => {},
      onProgress = () => {},
      onState = () => {},
    },
  ) {
    this.channel = channel;
    this.channel.binaryType = "arraybuffer";
    this.createSink = createSink;
    this.onManifest = onManifest;
    this.onProgress = onProgress;
    this.onState = onState;
    this.receivedFiles = [];
    this.processing = Promise.resolve();
    this.removeMessageListener = listen(channel, "message", (event) => {
      this.processing = this.processing
        .then(() => this.handleMessage(event.data))
        .catch((error) => this.fail(error));
    });
    this.removeCloseListener = listen(channel, "close", () => {
      if (["idle", "completed", "rejected", "cancelled", "failed"].includes(this.state)) return;
      this.processing = this.processing
        .then(() => this.fail(new Error("data channel closed")))
        .catch((error) => {
          this.error ??= error;
        });
    });
  }

  async handleMessage(data) {
    if (data instanceof ArrayBuffer) {
      if (this.state !== "receiving" || !this.currentFile) {
        throw new Error("received file bytes before a file was started");
      }
      const chunk = new Uint8Array(data);
      await this.currentFile.sink.write(chunk);
      this.currentFile.receivedBytes += chunk.byteLength;
      const overallBytes = this.completedBytes() + this.currentFile.receivedBytes;
      this.reportProgress(
        this.currentFile.file,
        this.nextFileIndex,
        this.currentFile.receivedBytes,
        overallBytes,
      );
      if (overallBytes - (this.lastAcknowledgedBytes ?? 0) >= ACK_INTERVAL_BYTES) {
        this.sendAcknowledgement(overallBytes);
      }
      return;
    }

    const message = readControl(data);
    if (
      message?.type === "cancel" &&
      message.transferId === this.manifest?.transferId
    ) {
      await this.finishCancelled();
      return;
    }
    if (
      message?.type === "error" &&
      message.transferId === this.manifest?.transferId
    ) {
      throw new TransferProtocolError(
        message.code || "REMOTE_TRANSFER_FAILED",
        "sender reported a transfer failure",
      );
    }
    if (message?.type === "offer_manifest" && this.state === "idle") {
      if (!isValidManifest(message)) {
        throw new TransferProtocolError("INVALID_MANIFEST", "manifest validation failed");
      }
      this.manifest = message;
      this.totalBytes = message.files.reduce((total, file) => total + file.size, 0);
      this.nextFileIndex = 0;
      this.setState("awaiting_acceptance");
      this.onManifest(message);
      return;
    }

    if (
      message?.type === "file_start" &&
      message.transferId === this.manifest?.transferId &&
      this.state === "receiving"
    ) {
      const file = this.manifest.files[this.nextFileIndex];
      if (!file || message.fileId !== file.id || message.size !== file.size || this.currentFile) {
        throw new Error("file start did not match the manifest");
      }
      this.currentFile = {
        file,
        sink: await this.createSink(file),
        receivedBytes: 0,
      };
      this.reportProgress(file, this.nextFileIndex, 0, this.completedBytes());
      return;
    }

    if (
      message?.type === "file_end" &&
      message.transferId === this.manifest?.transferId &&
      this.state === "receiving"
    ) {
      const current = this.currentFile;
      if (
        !current ||
        message.fileId !== current.file.id ||
        message.sentBytes !== current.file.size ||
        current.receivedBytes !== current.file.size ||
        (typeof current.sink.bytesWritten === "number" &&
          current.sink.bytesWritten !== current.file.size)
      ) {
        throw new TransferProtocolError(
          "BYTE_COUNT_MISMATCH",
          "file byte count did not match the manifest",
        );
      }

      const result = await current.sink.finalize();
      const finalOverallBytes = this.completedBytes() + current.receivedBytes;
      this.sendAcknowledgement(finalOverallBytes, current);
      this.receivedFiles.push({ file: current.file, result, sink: current.sink });
      this.currentFile = undefined;
      sendControl(this.channel, {
        type: "file_received",
        transferId: this.manifest.transferId,
        fileId: current.file.id,
        receivedBytes: current.receivedBytes,
      });
      this.nextFileIndex += 1;
      if (this.nextFileIndex === this.manifest.files.length) {
        sendControl(this.channel, {
          type: "transfer_complete",
          transferId: this.manifest.transferId,
        });
        this.setState("completed");
      }
    }
  }

  completedBytes() {
    return this.receivedFiles.reduce((total, entry) => total + entry.file.size, 0);
  }

  sendAcknowledgement(overallBytes, current = this.currentFile) {
    if (!current || overallBytes === this.lastAcknowledgedBytes) return;
    sendControl(this.channel, {
      type: "transfer_ack",
      transferId: this.manifest.transferId,
      fileId: current.file.id,
      receivedBytes: current.receivedBytes,
      overallBytes,
    });
    this.lastAcknowledgedBytes = overallBytes;
  }

  reportProgress(file, index, fileBytes, overallBytes) {
    this.onProgress({
      file,
      index,
      fileBytes,
      fileTotalBytes: file.size,
      overallBytes,
      totalBytes: this.totalBytes,
    });
  }

  setState(state) {
    this.state = state;
    this.onState(state);
  }

  accept() {
    if (this.state !== "awaiting_acceptance") {
      throw new Error("there is no manifest to accept");
    }
    this.setState("receiving");
    this.lastAcknowledgedBytes = 0;
    sendControl(this.channel, {
      type: "accept_manifest",
      transferId: this.manifest.transferId,
    });
  }

  reject() {
    if (this.state !== "awaiting_acceptance") {
      throw new Error("there is no manifest to reject");
    }
    sendControl(this.channel, {
      type: "reject_manifest",
      transferId: this.manifest.transferId,
    });
    this.setState("rejected");
  }

  async cancel() {
    if (["completed", "rejected", "cancelled", "failed"].includes(this.state)) return;
    try {
      sendControl(this.channel, {
        type: "cancel",
        transferId: this.manifest?.transferId,
        reason: "user",
      });
    } catch {
      // Local cleanup must still finish after a transport-level close.
    }
    await this.finishCancelled();
  }

  async finishCancelled() {
    if (["completed", "rejected", "cancelled", "failed"].includes(this.state)) return;
    const sink = this.currentFile?.sink;
    this.currentFile = undefined;
    this.setState("cancelled");
    if (sink?.abort) await sink.abort();
  }

  async fail(error) {
    if (["completed", "rejected", "cancelled", "failed"].includes(this.state)) return;
    this.setState("failed");
    this.error = error;
    if (this.currentFile?.sink.abort) {
      try {
        await this.currentFile.sink.abort();
      } catch {
        // Preserve the original protocol or transport failure.
      }
    }
    this.currentFile = undefined;
    try {
      sendControl(this.channel, {
        type: "error",
        transferId: this.manifest?.transferId,
        code: error?.code || "INVALID_TRANSFER",
      });
    } catch {
      // A closed transport cannot receive the diagnostic, but local cleanup is complete.
    }
  }
}
