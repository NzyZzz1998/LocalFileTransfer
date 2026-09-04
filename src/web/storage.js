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
    await this.writable.abort();
    await this.root.removeEntry(this.tempName);
    this.bytesWritten = 0;
    this.state = "aborted";
  }

  async cleanup() {
    if (this.state === "cleaned" || this.state === "aborted") return;
    await this.root.removeEntry(this.tempName);
    this.bytesWritten = 0;
    this.state = "cleaned";
  }
}

function temporaryName() {
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  return `.dukou-${id}.part`;
}

export async function createStorage({
  name,
  size,
  type,
  mime,
  maxMemoryBytes = DEFAULT_MEMORY_LIMIT_BYTES,
  navigator: navigatorRef = globalThis.navigator,
}) {
  requireSize(size);
  const blobType = type ?? mime ?? "";
  if (typeof navigatorRef?.storage?.getDirectory === "function") {
    let root;
    let tempName;
    let fileCreated = false;
    try {
      root = await navigatorRef.storage.getDirectory();
      tempName = temporaryName();
      const fileHandle = await root.getFileHandle(tempName, { create: true });
      fileCreated = true;
      const writable = await fileHandle.createWritable({ keepExistingData: false });
      return new OpfsSink({
        expectedSize: size,
        fileHandle,
        root,
        tempName,
        type: blobType,
        writable,
      });
    } catch {
      if (fileCreated && typeof root?.removeEntry === "function") {
        try {
          await root.removeEntry(tempName);
        } catch {
          // Best effort: failure to remove a partial OPFS file must not block fallback.
        }
      }
      // OPFS is capability-detected but can still be blocked by browser policy.
    }
  }
  return new MemorySink({ expectedSize: size, maxBytes: maxMemoryBytes, type: blobType });
}
