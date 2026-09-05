export const DEFAULT_MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;

export class StorageError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "StorageError";
    this.code = code;
  }
}

function asBytes(chunk) {
  if (chunk instanceof Uint8Array) return chunk;
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  throw new StorageError("INVALID_CHUNK", "Storage chunks must be Uint8Array or ArrayBuffer values");
}

function requireSize(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new StorageError("INVALID_SIZE", "File sizes must be non-negative safe integers");
  }
}

function requireLimit(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new StorageError("INVALID_LIMIT", "Memory limits must be non-negative safe integers");
  }
}

export async function assessStorageCapability(
  files,
  navigatorRef = globalThis.navigator,
  limitBytes = DEFAULT_MEMORY_LIMIT_BYTES,
  { signal } = {},
) {
  requireLimit(limitBytes);
  throwIfAborted(signal);
  if (!Array.isArray(files)) {
    throw new StorageError("INVALID_MANIFEST", "The storage manifest must be an array of files");
  }
  // Validate the entire manifest before touching storage, including on OPFS.
  // Keep only the first memory-limit violation, but do not let it hide invalid
  // metadata later in the batch.
  let total = 0;
  let memoryFailure = null;
  for (const [fileIndex, file] of files.entries()) {
    const location = { fileIndex, fileName: typeof file?.name === "string" ? file.name : "" };
    try {
      requireSize(file?.size);
      total += file.size;
      if (!Number.isSafeInteger(total)) {
        throw new StorageError("INVALID_TOTAL_SIZE", "The batch size exceeds a safe integer");
      }
    } catch (error) {
      Object.assign(error, location);
      throw error;
    }
    if (!memoryFailure && (file.size > limitBytes || total > limitBytes)) {
      memoryFailure = {
        code: file.size > limitBytes ? "FILE_TOO_LARGE" : "BATCH_TOO_LARGE",
        ...location,
      };
    }
  }
  if (typeof navigatorRef?.storage?.getDirectory === "function") {
    try {
      if (await probeOpfs(navigatorRef, signal)) {
        // A tiny successful write proves capability, not reserved disk space.
        return { mode: "opfs", allowed: true, limitBytes: null, remainingBytes: null, code: null };
      }
    } catch (error) {
      if (error.name === "AbortError") throw error;
      if (error.code === "STORAGE_CLEANUP_FAILED") {
        return {
          mode: "opfs", allowed: false, limitBytes: null,
          remainingBytes: null, code: error.code,
        };
      }
      throw error;
    }
  }
  throwIfAborted(signal);
  return {
    mode: "memory", allowed: !memoryFailure, limitBytes, remainingBytes: null,
    code: null, ...memoryFailure,
  };
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new DOMException("Storage preflight was cancelled", "AbortError");
}

async function probeOpfs(navigatorRef, signal) {
  let root;
  let tempName;
  let writable;
  let created = false;
  let removalAttempts = 0;
  let available = false;
  async function removeProbe() {
    removalAttempts += 1;
    try {
      await root.removeEntry(tempName);
      created = false;
    } catch (error) {
      if (error.name !== "NotFoundError") throw error;
      created = false;
    }
  }
  try {
    root = await navigatorRef.storage.getDirectory();
    throwIfAborted(signal);
    if (typeof root?.getFileHandle !== "function" || typeof root?.removeEntry !== "function") {
      return false;
    }
    tempName = temporaryName("probe");
    // Also attempt cleanup if creation itself rejects after making the entry.
    created = true;
    const fileHandle = await root.getFileHandle(tempName, { create: true });
    throwIfAborted(signal);
    writable = await fileHandle.createWritable({ keepExistingData: false });
    throwIfAborted(signal);
    await writable.write(Uint8Array.of(0));
    throwIfAborted(signal);
    await writable.close();
    writable = null;
    throwIfAborted(signal);
    await removeProbe();
    available = true;
  } catch {
    // API presence alone is insufficient: policies, stream creation and writes
    // can fail independently. Only a full successful probe selects OPFS.
  } finally {
    if (writable) {
      try { await writable.abort(); } catch { /* Still attempt entry removal. */ }
    }
    // One bounded retry handles a transient removal failure without hiding a
    // persistent orphan or retrying indefinitely after the user has cancelled.
    while (created && removalAttempts < 2) {
      try { await removeProbe(); } catch { /* Report a persistent failure below. */ }
    }
  }
  throwIfAborted(signal);
  if (created) {
    throw new StorageError("STORAGE_CLEANUP_FAILED", "The storage probe could not be removed");
  }
  return available;
}

export class MemorySink {
  constructor({ expectedSize, maxBytes = DEFAULT_MEMORY_LIMIT_BYTES, type = "" }) {
    requireSize(expectedSize);
    requireLimit(maxBytes);
    if (expectedSize > maxBytes) {
      throw new StorageError(
        "STORAGE_LIMIT_EXCEEDED",
        `The declared size of ${expectedSize} bytes exceeds the ${maxBytes} byte memory limit`,
      );
    }
    this.expectedSize = expectedSize;
    this.maxBytes = maxBytes;
    this.type = type;
    this.kind = "memory";
    this.bytesWritten = 0;
    this.parts = [];
    this.state = "open";
  }

  async write(chunk) {
    if (this.state === "cleaned") {
      throw new StorageError("STORAGE_CLEANED", "The memory sink has been cleaned up");
    }
    if (this.state === "aborted") {
      throw new StorageError("STORAGE_ABORTED", "The memory sink has been aborted");
    }
    if (this.state === "finalized") {
      throw new StorageError("STORAGE_FINALIZED", "The memory sink has been finalized");
    }
    const bytes = asBytes(chunk);
    if (this.bytesWritten + bytes.byteLength > this.expectedSize) {
      throw new StorageError(
        "SIZE_MISMATCH",
        `Chunk would exceed the declared size of ${this.expectedSize} bytes`,
      );
    }
    this.parts.push(bytes.slice());
    this.bytesWritten += bytes.byteLength;
  }

  async finalize() {
    if (this.state === "cleaned") {
      throw new StorageError("STORAGE_CLEANED", "The memory sink has been cleaned up");
    }
    if (this.state === "aborted") {
      throw new StorageError("STORAGE_ABORTED", "The memory sink has been aborted");
    }
    if (this.bytesWritten !== this.expectedSize) {
      throw new StorageError(
        "SIZE_MISMATCH",
        `Expected ${this.expectedSize} bytes but received ${this.bytesWritten}`,
      );
    }
    const blob = new Blob(this.parts, { type: this.type });
    this.state = "finalized";
    return blob;
  }

  async abort() {
    this.parts = [];
    this.bytesWritten = 0;
    this.state = "aborted";
  }

  async cleanup() {
    this.parts = [];
    this.bytesWritten = 0;
    this.state = "cleaned";
  }
}

class OpfsSink {
  constructor({ expectedSize, fileHandle, root, tempName, type, writable }) {
    this.expectedSize = expectedSize;
    this.fileHandle = fileHandle;
    this.root = root;
    this.tempName = tempName;
    this.type = type;
    this.writable = writable;
    this.kind = "opfs";
    this.bytesWritten = 0;
    this.state = "open";
  }

  async write(chunk) {
    if (this.state === "cleaned") {
      throw new StorageError("STORAGE_CLEANED", "The OPFS sink has been cleaned up");
    }
    if (this.state === "aborted") {
      throw new StorageError("STORAGE_ABORTED", "The OPFS sink has been aborted");
    }
    if (this.state === "finalized") {
      throw new StorageError("STORAGE_FINALIZED", "The OPFS sink has been finalized");
    }
    const bytes = asBytes(chunk);
    if (this.bytesWritten + bytes.byteLength > this.expectedSize) {
      throw new StorageError(
        "SIZE_MISMATCH",
        `Chunk would exceed the declared size of ${this.expectedSize} bytes`,
      );
    }
    await this.writable.write(bytes);
    this.bytesWritten += bytes.byteLength;
  }

  async finalize() {
    if (this.state === "cleaned") {
      throw new StorageError("STORAGE_CLEANED", "The OPFS sink has been cleaned up");
    }
    if (this.state === "aborted") {
      throw new StorageError("STORAGE_ABORTED", "The OPFS sink has been aborted");
    }
    if (this.bytesWritten !== this.expectedSize) {
      throw new StorageError(
        "SIZE_MISMATCH",
        `Expected ${this.expectedSize} bytes but received ${this.bytesWritten}`,
      );
    }
    await this.writable.close();
    const file = await this.fileHandle.getFile();
    this.state = "finalized";
    return this.type ? file.slice(0, file.size, this.type) : file;
  }

  async abort() {
    if (this.state === "aborted") return;
    try {
      await this.writable.abort();
    } finally {
      // An already errored stream can reject abort while its temporary entry
      // still needs removal. Leave state retryable if removal itself fails.
      await this.root.removeEntry(this.tempName);
      this.bytesWritten = 0;
      this.state = "aborted";
    }
  }

  async cleanup() {
    if (this.state === "cleaned" || this.state === "aborted") return;
    await this.root.removeEntry(this.tempName);
    this.bytesWritten = 0;
    this.state = "cleaned";
  }
}

function temporaryName(purpose = "transfer") {
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  return `.dukou-${purpose}-${id}.part`;
}

export async function createStorage({
  name,
  size,
  type,
  mime,
  maxMemoryBytes = DEFAULT_MEMORY_LIMIT_BYTES,
  navigator: navigatorRef = globalThis.navigator,
  mode = "auto",
}) {
  requireSize(size);
  requireLimit(maxMemoryBytes);
  if (!["auto", "opfs", "memory"].includes(mode)) {
    throw new StorageError("INVALID_STORAGE_MODE", "Storage mode must be auto, opfs or memory");
  }
  const blobType = type ?? mime ?? "";
  if (mode !== "memory" && typeof navigatorRef?.storage?.getDirectory === "function") {
    let root;
    let tempName;
    let fileCreated = false;
    try {
      root = await navigatorRef.storage.getDirectory();
      if (typeof root?.getFileHandle !== "function" || typeof root?.removeEntry !== "function") {
        throw new StorageError("OPFS_UNAVAILABLE", "The OPFS file APIs are unavailable");
      }
      tempName = temporaryName();
      fileCreated = true;
      const fileHandle = await root.getFileHandle(tempName, { create: true });
      const writable = await fileHandle.createWritable({ keepExistingData: false });
      return new OpfsSink({
        expectedSize: size,
        fileHandle,
        root,
        tempName,
        type: blobType,
        writable,
      });
    } catch (cause) {
      if (fileCreated && typeof root?.removeEntry === "function") {
        for (let attempt = 0; fileCreated && attempt < 2; attempt += 1) {
          try {
            await root.removeEntry(tempName);
            fileCreated = false;
          } catch (error) {
            if (error.name === "NotFoundError") fileCreated = false;
          }
        }
        if (fileCreated) {
          throw new StorageError("STORAGE_CLEANUP_FAILED", "The partial OPFS file could not be removed");
        }
      }
      if (mode === "opfs") {
        const error = new StorageError("OPFS_UNAVAILABLE", "The selected OPFS storage is no longer available");
        error.cause = cause;
        throw error;
      }
      // Only callers selecting auto may fall back. A preflight-locked batch
      // cannot change its memory/storage contract after the user accepts it.
    }
  }
  if (mode === "opfs") {
    throw new StorageError("OPFS_UNAVAILABLE", "The selected OPFS storage is unavailable");
  }
  return new MemorySink({ expectedSize: size, maxBytes: maxMemoryBytes, type: blobType });
}
