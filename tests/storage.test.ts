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
    expect(result).toEqual({
      mode: "memory",
      allowed: false,
      limitBytes: 256 * 1024 * 1024,
      code: "BATCH_TOO_LARGE",
    });
  });

  test("blocks an oversized memory file before receiving bytes", async () => {
    const result = await assessStorageCapability(
      [{ name: "large.bin", size: 256 * 1024 * 1024 + 1 }],
      {},
    );
    expect(result).toMatchObject({ mode: "memory", allowed: false, code: "FILE_TOO_LARGE" });
  });

  test("allows a large manifest when OPFS can actually be opened", async () => {
    const result = await assessStorageCapability(
      [{ name: "large.bin", size: 300 * 1024 * 1024 }],
      { storage: { getDirectory: async () => ({}) } },
    );
    expect(result).toEqual({ mode: "opfs", allowed: true, limitBytes: null });
  });
});

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
