import { describe, expect, test } from "bun:test";

import { MemorySink, assessStorageCapability, createStorage } from "../src/web/storage.js";

describe("storage capability preflight", () => {
  test("blocks a memory-only batch whose aggregate size exceeds 256 MiB", async () => {
    const result = await assessStorageCapability(
      [
        { name: "first.bin", size: 200 * 1024 * 1024 },
        { name: "second.bin", size: 57 * 1024 * 1024 },
      ],
      {},
    );
    expect(result).toMatchObject({
      mode: "memory",
      allowed: false,
      limitBytes: 256 * 1024 * 1024,
      code: "BATCH_TOO_LARGE",
      fileIndex: 1,
      fileName: "second.bin",
    });
  });

  test("blocks an oversized memory file before receiving bytes", async () => {
    const result = await assessStorageCapability(
      [{ name: "large.bin", size: 256 * 1024 * 1024 + 1 }],
      {},
    );
    expect(result).toMatchObject({ mode: "memory", allowed: false, code: "FILE_TOO_LARGE" });
  });

  test("refuses a large file when OPFS opens but is not writable", async () => {
    const opfs = createProbeOpfs("createWritable");
    const result = await assessStorageCapability(
      [{ name: "large.bin", size: 300 * 1024 * 1024 }],
      opfs,
    );
    expect(result).toMatchObject({
      mode: "memory", allowed: false, code: "FILE_TOO_LARGE",
      fileIndex: 0, fileName: "large.bin", remainingBytes: null,
    });
    expect(opfs.state.entries.size).toBe(0);
  });

  test("refuses an oversized batch when failed OPFS leaves only memory storage", async () => {
    const opfs = createProbeOpfs("write");
    const result = await assessStorageCapability([
      { name: "first.bin", size: 200 * 1024 * 1024 },
      { name: "second.bin", size: 57 * 1024 * 1024 },
    ], opfs);
    expect(result).toMatchObject({
      mode: "memory", allowed: false, code: "BATCH_TOO_LARGE", fileIndex: 1, fileName: "second.bin",
    });
    expect(opfs.state.entries.size).toBe(0);
  });

  test("allows a large manifest only after a small probe is written and removed", async () => {
    const opfs = createProbeOpfs();
    const result = await assessStorageCapability(
      [{ name: "large.bin", size: 300 * 1024 * 1024 }],
      opfs,
    );
    expect(result).toMatchObject({
      mode: "opfs", allowed: true, limitBytes: null, remainingBytes: null, code: null,
    });
    expect(opfs.state.writtenBytes).toBeGreaterThan(0);
    expect(opfs.state.writtenBytes).toBeLessThanOrEqual(16);
    expect(opfs.state.entries.size).toBe(0);
  });

  test.each(["getDirectory", "getFileHandle", "createWritable", "write", "close", "remove"])(
    "uses safe memory fallback and cleans its probe after OPFS %s failure",
    async (stage) => {
      const opfs = createProbeOpfs(stage);
      const result = await assessStorageCapability([{ name: "small.bin", size: 7 }], opfs);
      expect(result).toMatchObject({ mode: "memory", allowed: true, code: null });
      expect(opfs.state.entries.size).toBe(0);
    },
  );

  test("does not hide a persistent failure to remove the probe", async () => {
    const opfs = createProbeOpfs("remove", Number.POSITIVE_INFINITY);
    const result = await assessStorageCapability([{ name: "small.bin", size: 7 }], opfs);
    expect(result).toMatchObject({ allowed: false, code: "STORAGE_CLEANUP_FAILED" });
    expect(opfs.state.entries.size).toBe(1);
    expect(opfs.state.removalAttempts).toBeLessThanOrEqual(2);
  });

  test.each([-1, 1.5, Number.POSITIVE_INFINITY, undefined])(
    "validates every file before probing writable OPFS for size %p",
    async (size) => {
      const opfs = createProbeOpfs();
      await expect(assessStorageCapability([
        { name: "oversized.bin", size: 300 * 1024 * 1024 },
        { name: "invalid.bin", size },
      ], opfs)).rejects.toMatchObject({
        code: "INVALID_SIZE", fileIndex: 1, fileName: "invalid.bin",
      });
      expect(opfs.state.directoryRequests).toBe(0);
    },
  );

  test("rejects aggregate integer overflow before probing OPFS", async () => {
    const opfs = createProbeOpfs();
    await expect(assessStorageCapability([
      { name: "first.bin", size: Number.MAX_SAFE_INTEGER },
      { name: "overflow.bin", size: 1 },
    ], opfs)).rejects.toMatchObject({ code: "INVALID_TOTAL_SIZE", fileIndex: 1 });
    expect(opfs.state.directoryRequests).toBe(0);
  });

  test.each([null, {}, "not-a-manifest"])("rejects malformed manifest %p before probing", async (files) => {
    const opfs = createProbeOpfs();
    await expect(assessStorageCapability(files, opfs)).rejects.toMatchObject({ code: "INVALID_MANIFEST" });
    expect(opfs.state.directoryRequests).toBe(0);
  });

  test("allows zero-byte files and the exact aggregate memory boundary", async () => {
    const result = await assessStorageCapability([
      { name: "empty.bin", size: 0 },
      { name: "one.bin", size: 128 * 1024 * 1024 },
      { name: "two.bin", size: 128 * 1024 * 1024 },
    ], {});
    expect(result).toMatchObject({ mode: "memory", allowed: true, code: null });
    const opfs = createProbeOpfs();
    expect(await assessStorageCapability([{ name: "empty.bin", size: 0 }], opfs))
      .toMatchObject({ mode: "opfs", allowed: true });
    expect(opfs.state.entries.size).toBe(0);
  });

  test("does not probe storage for an already cancelled preflight", async () => {
    const opfs = createProbeOpfs();
    const controller = new AbortController();
    controller.abort();
    await expect(assessStorageCapability([], opfs, 10, { signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(opfs.state.directoryRequests).toBe(0);
  });

  test.each(["createWritable", "write"])(
    "cleans a probe when cancellation arrives during %s",
    async (stage) => {
      let release!: () => void;
      let entered!: () => void;
      const operationStarted = new Promise<void>((resolve) => { entered = resolve; });
      const pendingOperation = new Promise<void>((resolve) => { release = resolve; });
      const opfs = createProbeOpfs(undefined, 0, async (operation) => {
        if (operation === stage) {
          entered();
          await pendingOperation;
        }
      });
      const controller = new AbortController();
      const preflight = assessStorageCapability([{ name: "small.bin", size: 1 }], opfs, 10, {
        signal: controller.signal,
      });
      await operationStarted;
      controller.abort();
      release();
      await expect(preflight).rejects.toMatchObject({ name: "AbortError" });
      expect(opfs.state.entries.size).toBe(0);
    },
  );

  test("concurrent probes do not overwrite or remove each other's files", async () => {
    const opfs = createProbeOpfs();
    const results = await Promise.all([
      assessStorageCapability([{ size: 1 }], opfs),
      assessStorageCapability([{ size: 2 }], opfs),
    ]);
    expect(results.every((result) => result.allowed && result.mode === "opfs")).toBe(true);
    expect(new Set(opfs.state.createdNames).size).toBe(2);
    expect(opfs.state.entries.size).toBe(0);
  });
});

// OPFS is a browser-only filesystem. This double models its stream locks and
// persistent entries so cleanup assertions catch resource leaks, not mock calls.
function createProbeOpfs(
  failureStage?: string,
  failuresRemaining = 1,
  beforeOperation: (stage: string) => Promise<void> = async () => {},
) {
  const state = {
    entries: new Map<string, { open: boolean }>(),
    createdNames: [] as string[],
    directoryRequests: 0,
    writtenBytes: 0,
    removalAttempts: 0,
  };
  async function operate(stage: string) {
    await beforeOperation(stage);
    if (stage === failureStage && failuresRemaining-- > 0) {
      throw new DOMException(`${stage} blocked`, "QuotaExceededError");
    }
  }
  const root = {
    async getFileHandle(name: string, options: { create: boolean }) {
      if (!options.create || state.entries.has(name)) throw new Error("probe name reused");
      const entry = { open: false };
      state.entries.set(name, entry);
      state.createdNames.push(name);
      await operate("getFileHandle");
      return {
        async createWritable() {
          await operate("createWritable");
          entry.open = true;
          return {
            async write(bytes: Uint8Array) {
              await operate("write");
              if (!entry.open) throw new Error("write after close");
              state.writtenBytes += bytes.byteLength;
            },
            async close() {
              await operate("close");
              entry.open = false;
            },
            async abort() {
              entry.open = false;
              await operate("abort");
            },
          };
        },
      };
    },
    async removeEntry(name: string) {
      state.removalAttempts += 1;
      await operate("remove");
      const entry = state.entries.get(name);
      if (!entry) throw new DOMException("missing", "NotFoundError");
      if (entry.open) throw new DOMException("locked", "InvalidStateError");
      state.entries.delete(name);
    },
  };
  return {
    state,
    storage: {
      async getDirectory() {
        state.directoryRequests += 1;
        await operate("getDirectory");
        return root;
      },
    },
  };
}

function createFakeOpfs() {
  const chunks: Uint8Array[] = [];
  let closed = false;
  const state = { aborts: 0, removedNames: [] as string[] };

  const fileHandle = {
    async createWritable() {
      return {
        async write(chunk: Uint8Array | ArrayBuffer) {
          const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
          chunks.push(bytes.slice());
        },
        async close() {
          closed = true;
        },
        async abort() {
          state.aborts += 1;
        },
      };
    },
    async getFile() {
      if (!closed) throw new Error("file requested before stream close");
      return new Blob(chunks);
    },
  };

  const root = {
    async getFileHandle() {
      return fileHandle;
    },
    async removeEntry(name: string) {
      state.removedNames.push(name);
    },
  };

  return {
    state,
    storage: {
      async getDirectory() {
        return root;
      },
    },
  };
}

describe("MemorySink", () => {
  test.each([-1, 1.5, Number.POSITIVE_INFINITY])(
    "rejects invalid declared size %p",
    (expectedSize) => {
      expect(() => new MemorySink({ expectedSize, maxBytes: 10 })).toThrow(
        expect.objectContaining({ code: "INVALID_SIZE" }),
      );
    },
  );

  test("rejects an invalid configured memory limit", () => {
    expect(() => new MemorySink({ expectedSize: 0, maxBytes: -1 })).toThrow(
      expect.objectContaining({ code: "INVALID_LIMIT" }),
    );
  });

  test("assembles exact ArrayBuffer and Uint8Array chunks into a Blob", async () => {
    const sink = new MemorySink({
      expectedSize: 5,
      maxBytes: 5,
      type: "text/plain",
    });

    await sink.write(Uint8Array.of(104, 101).buffer);
    const backing = Uint8Array.of(255, 108, 108, 111, 255);
    await sink.write(backing.subarray(1, 4));

    expect(sink.bytesWritten).toBe(5);
    const blob = await sink.finalize();
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type.startsWith("text/plain")).toBe(true);
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([104, 101, 108, 108, 111]);
  });

  test("rejects finalization when fewer bytes arrived than declared", async () => {
    const sink = new MemorySink({ expectedSize: 4, maxBytes: 4 });
    await sink.write(Uint8Array.of(1, 2, 3));

    await expect(sink.finalize()).rejects.toMatchObject({ code: "SIZE_MISMATCH" });
  });

  test("rejects a chunk that would exceed the declared file size", async () => {
    const sink = new MemorySink({ expectedSize: 3, maxBytes: 10 });
    await sink.write(Uint8Array.of(1, 2));

    await expect(sink.write(Uint8Array.of(3, 4))).rejects.toMatchObject({
      code: "SIZE_MISMATCH",
    });
    expect(sink.bytesWritten).toBe(2);
  });

  test("rejects a declared file larger than the configured memory limit", () => {
    expect(() => new MemorySink({ expectedSize: 5, maxBytes: 4 })).toThrow(
      expect.objectContaining({ code: "STORAGE_LIMIT_EXCEEDED" }),
    );
  });

  test("abort discards buffered bytes and prevents finalization", async () => {
    const sink = new MemorySink({ expectedSize: 2, maxBytes: 2 });
    await sink.write(Uint8Array.of(1, 2));

    await sink.abort();

    expect(sink.bytesWritten).toBe(0);
    await expect(sink.finalize()).rejects.toMatchObject({ code: "STORAGE_ABORTED" });
  });

  test("an aborted sink rejects later chunks", async () => {
    const sink = new MemorySink({ expectedSize: 1, maxBytes: 1 });
    await sink.abort();

    await expect(sink.write(Uint8Array.of(1))).rejects.toMatchObject({
      code: "STORAGE_ABORTED",
    });
  });

  test("rejects values that are not ArrayBuffer or Uint8Array chunks", async () => {
    const sink = new MemorySink({ expectedSize: 1, maxBytes: 1 });

    await expect(sink.write(new Blob([Uint8Array.of(1)]))).rejects.toMatchObject({
      code: "INVALID_CHUNK",
    });
    expect(sink.bytesWritten).toBe(0);
  });

  test("rejects chunks after finalization", async () => {
    const sink = new MemorySink({ expectedSize: 1, maxBytes: 1 });
    await sink.write(Uint8Array.of(1));
    await sink.finalize();

    await expect(sink.write(new ArrayBuffer(0))).rejects.toMatchObject({
      code: "STORAGE_FINALIZED",
    });
  });

  test("cleanup releases a finalized sink and makes it unusable", async () => {
    const sink = new MemorySink({ expectedSize: 1, maxBytes: 1 });
    await sink.write(Uint8Array.of(9));
    await sink.finalize();

    await sink.cleanup();

    expect(sink.bytesWritten).toBe(0);
    await expect(sink.finalize()).rejects.toMatchObject({ code: "STORAGE_CLEANED" });
    await expect(sink.write(Uint8Array.of(9))).rejects.toMatchObject({
      code: "STORAGE_CLEANED",
    });
  });
});

describe("createStorage", () => {
  test("keeps a locked memory batch in memory without probing OPFS again", async () => {
    const opfs = createProbeOpfs();
    const sink = await createStorage({ size: 1, navigator: opfs, mode: "memory" });
    expect(sink.kind).toBe("memory");
    await sink.write(Uint8Array.of(9));
    expect([...new Uint8Array(await (await sink.finalize()).arrayBuffer())]).toEqual([9]);
    expect(opfs.state.directoryRequests).toBe(0);
  });

  test.each([{}, createProbeOpfs("getDirectory"), createProbeOpfs("createWritable")])(
    "does not silently downgrade locked OPFS when opening the real sink fails",
    async (navigator) => {
      await expect(createStorage({ size: 1, navigator, mode: "opfs" }))
        .rejects.toMatchObject({ code: "OPFS_UNAVAILABLE" });
      if ("state" in navigator) expect(navigator.state.entries.size).toBe(0);
    },
  );

  test("locked OPFS stores a file even when it exceeds the memory budget", async () => {
    const sink = await createStorage({
      size: 2, maxMemoryBytes: 1, navigator: createFakeOpfs(), mode: "opfs",
    });
    await sink.write(Uint8Array.of(3, 4));
    expect([...new Uint8Array(await (await sink.finalize()).arrayBuffer())]).toEqual([3, 4]);
    await sink.cleanup();
  });

  test("rejects an unsupported storage mode before opening OPFS", async () => {
    const opfs = createProbeOpfs();
    await expect(createStorage({ size: 1, navigator: opfs, mode: "unknown" }))
      .rejects.toMatchObject({ code: "INVALID_STORAGE_MODE" });
    expect(opfs.state.directoryRequests).toBe(0);
  });

  test("validates the memory contract even if OPFS is available", async () => {
    const opfs = createProbeOpfs();
    await expect(createStorage({ size: 1, maxMemoryBytes: -1, navigator: opfs }))
      .rejects.toMatchObject({ code: "INVALID_LIMIT" });
    expect(opfs.state.directoryRequests).toBe(0);
  });

  test("removes a partially created real sink before reporting locked OPFS failure", async () => {
    const opfs = createProbeOpfs("getFileHandle");
    await expect(createStorage({ size: 1, navigator: opfs, mode: "opfs" }))
      .rejects.toMatchObject({ code: "OPFS_UNAVAILABLE" });
    expect(opfs.state.entries.size).toBe(0);
  });

  test("reports a persistent real-sink cleanup failure without silently using memory", async () => {
    const opfs = createProbeOpfs("remove", Number.POSITIVE_INFINITY, async (stage) => {
      if (stage === "createWritable") throw new Error("writable denied");
    });
    await expect(createStorage({ size: 1, navigator: opfs }))
      .rejects.toMatchObject({ code: "STORAGE_CLEANUP_FAILED" });
    expect(opfs.state.removalAttempts).toBeLessThanOrEqual(2);
  });

  test("rejects invalid file metadata before selecting a backend", async () => {
    await expect(
      createStorage({
        name: "invalid.bin",
        size: -1,
        maxMemoryBytes: 1,
        navigator: createFakeOpfs(),
      }),
    ).rejects.toMatchObject({ code: "INVALID_SIZE" });
  });

  test("falls back to memory when OPFS is unavailable", async () => {
    const sink = await createStorage({
      name: "note.txt",
      size: 2,
      type: "text/plain",
      maxMemoryBytes: 2,
      navigator: {},
    });

    expect(sink).toBeInstanceOf(MemorySink);
    expect(sink.kind).toBe("memory");
  });

  test("accepts the manifest mime field for the download Blob", async () => {
    const sink = await createStorage({
      name: "note.txt",
      size: 1,
      mime: "application/x-dukou-test",
      maxMemoryBytes: 1,
      navigator: {},
    });
    await sink.write(Uint8Array.of(1));

    const blob = await sink.finalize();
    expect(blob.type).toBe("application/x-dukou-test");
  });

  test("applies a finite safe memory limit when no override is supplied", async () => {
    await expect(
      createStorage({
        name: "too-large.bin",
        size: Number.MAX_SAFE_INTEGER,
        navigator: {},
      }),
    ).rejects.toMatchObject({ code: "STORAGE_LIMIT_EXCEEDED" });
  });

  test("prefers OPFS and streams chunks without applying the memory limit", async () => {
    const sink = await createStorage({
      name: "archive.bin",
      size: 3,
      mime: "application/octet-stream",
      maxMemoryBytes: 1,
      navigator: createFakeOpfs(),
    });

    expect(sink.kind).toBe("opfs");
    await sink.write(Uint8Array.of(7, 8));
    await sink.write(Uint8Array.of(9).buffer);
    const blob = await sink.finalize();
    expect(blob.type).toBe("application/octet-stream");
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([7, 8, 9]);
  });

  test.serial("uses the browser navigator when no navigator override is supplied", async () => {
    const originalNavigator = globalThis.navigator;
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: createFakeOpfs(),
      writable: true,
    });

    try {
      const sink = await createStorage({
        name: "ambient.bin",
        size: 2,
        maxMemoryBytes: 1,
      });
      expect(sink.kind).toBe("opfs");
    } finally {
      Object.defineProperty(globalThis, "navigator", {
        configurable: true,
        value: originalNavigator,
        writable: true,
      });
    }
  });

  test("falls back to memory when OPFS initialization fails", async () => {
    const sink = await createStorage({
      name: "note.txt",
      size: 1,
      maxMemoryBytes: 1,
      navigator: {
        storage: {
          async getDirectory() {
            throw new DOMException("blocked", "SecurityError");
          },
        },
      },
    });

    expect(sink).toBeInstanceOf(MemorySink);
    await sink.write(Uint8Array.of(42));
    expect(new Uint8Array(await (await sink.finalize()).arrayBuffer())[0]).toBe(42);
  });

  test("removes a partial OPFS file before falling back to memory", async () => {
    const removedNames: string[] = [];
    const root = {
      async getFileHandle() {
        return {
          async createWritable() {
            throw new DOMException("quota", "QuotaExceededError");
          },
        };
      },
      async removeEntry(name: string) {
        removedNames.push(name);
      },
    };

    const sink = await createStorage({
      name: "fallback.bin",
      size: 1,
      maxMemoryBytes: 1,
      navigator: { storage: { async getDirectory() { return root; } } },
    });

    expect(sink.kind).toBe("memory");
    expect(removedNames).toHaveLength(1);
  });

  test("an OPFS sink aborts its stream and removes the temporary file", async () => {
    const opfs = createFakeOpfs();
    const sink = await createStorage({
      name: "partial.bin",
      size: 2,
      maxMemoryBytes: 1,
      navigator: opfs,
    });
    await sink.write(Uint8Array.of(1));

    await sink.abort();
    await sink.abort();
    await sink.cleanup();

    expect(opfs.state.aborts).toBe(1);
    expect(opfs.state.removedNames).toHaveLength(1);
    expect(sink.bytesWritten).toBe(0);
    await expect(sink.finalize()).rejects.toMatchObject({ code: "STORAGE_ABORTED" });
    await expect(sink.write(new ArrayBuffer(0))).rejects.toMatchObject({
      code: "STORAGE_ABORTED",
    });
  });

  test("an OPFS sink removes its file even when stream abort rejects", async () => {
    const opfs = createProbeOpfs("abort");
    const sink = await createStorage({ size: 1, mode: "opfs", navigator: opfs });
    await sink.write(Uint8Array.of(7));

    await expect(sink.abort()).rejects.toThrow("abort blocked");

    expect(opfs.state.entries.size).toBe(0);
    expect(sink.bytesWritten).toBe(0);
    await sink.abort();
    await sink.cleanup();
    expect(opfs.state.removalAttempts).toBe(1);
    await expect(sink.write(Uint8Array.of(9))).rejects.toMatchObject({ code: "STORAGE_ABORTED" });
  });

  test("a failed removal after stream abort rejection remains retryable by cleanup", async () => {
    const opfs = createProbeOpfs("remove", 1, async (stage) => {
      if (stage === "abort") throw new Error("stream already errored");
    });
    const sink = await createStorage({ size: 1, mode: "opfs", navigator: opfs });
    await sink.write(Uint8Array.of(7));

    await expect(sink.abort()).rejects.toThrow("remove blocked");
    expect(opfs.state.entries.size).toBe(1);
    expect(sink.state).not.toBe("aborted");

    await sink.cleanup();
    expect(opfs.state.entries.size).toBe(0);
    expect(sink.bytesWritten).toBe(0);
    await sink.cleanup();
    expect(opfs.state.removalAttempts).toBe(2);
  });

  test("cleanup removes a finalized OPFS temporary file", async () => {
    const opfs = createFakeOpfs();
    const sink = await createStorage({
      name: "complete.bin",
      size: 1,
      maxMemoryBytes: 1,
      navigator: opfs,
    });
    await sink.write(Uint8Array.of(5));
    const blob = await sink.finalize();
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([5]);

    await sink.cleanup();
    await sink.cleanup();

    expect(opfs.state.aborts).toBe(0);
    expect(opfs.state.removedNames).toHaveLength(1);
    expect(sink.bytesWritten).toBe(0);
    await expect(sink.write(Uint8Array.of(5))).rejects.toMatchObject({
      code: "STORAGE_CLEANED",
    });
  });

  test("an OPFS sink rejects chunks after finalization", async () => {
    const sink = await createStorage({
      name: "closed.bin",
      size: 1,
      maxMemoryBytes: 1,
      navigator: createFakeOpfs(),
    });
    await sink.write(Uint8Array.of(1));
    await sink.finalize();

    await expect(sink.write(new ArrayBuffer(0))).rejects.toMatchObject({
      code: "STORAGE_FINALIZED",
    });
  });

  test("an OPFS sink rejects finalization when bytes are missing", async () => {
    const sink = await createStorage({
      name: "short.bin",
      size: 2,
      maxMemoryBytes: 1,
      navigator: createFakeOpfs(),
    });
    await sink.write(Uint8Array.of(1));

    await expect(sink.finalize()).rejects.toMatchObject({ code: "SIZE_MISMATCH" });
  });

  test("an OPFS sink rejects a chunk larger than the remaining file size", async () => {
    const sink = await createStorage({
      name: "overflow.bin",
      size: 1,
      maxMemoryBytes: 1,
      navigator: createFakeOpfs(),
    });

    await expect(sink.write(Uint8Array.of(1, 2))).rejects.toMatchObject({
      code: "SIZE_MISMATCH",
    });
    expect(sink.bytesWritten).toBe(0);
  });
});
