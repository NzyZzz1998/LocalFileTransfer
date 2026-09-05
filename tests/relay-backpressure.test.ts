import { describe, expect, test } from "bun:test";
import { RelayBackpressure } from "../src/relay-backpressure";

function fakeSocket(result = -1) {
  return {
    buffered: 0,
    writes: 0,
    getBufferedAmount() { return this.buffered; },
    send(frame: string | Uint8Array) {
      this.writes += 1;
      const size = typeof frame === "string" ? frame.length : frame.byteLength;
      if (result === -1) this.buffered += size + (size <= 125 ? 2 : size <= 65_535 ? 4 : 10);
      return result;
    },
  };
}

describe("relay native websocket backpressure", () => {
  test("accepts -1 as already enqueued exactly once and reclaims capacity on drain", () => {
    const queue = new RelayBackpressure({ maxSocketBytes: 6, maxSessionBytes: 8, maxTotalBytes: 8 });
    const socket = fakeSocket();
    expect(queue.send("one", "room", socket, new Uint8Array(4))).toBe(true);
    expect(socket.writes).toBe(1);
    expect(queue.send("one", "room", socket, new Uint8Array(1))).toBe(false);
    expect(socket.writes).toBe(1);
    socket.buffered = 0;
    queue.drain("one");
    expect(queue.send("one", "room", socket, new Uint8Array(4))).toBe(true);
    expect(socket.writes).toBe(2);
  });

  test("rejects dropped frames, per-session queues and global queues explicitly", () => {
    const queue = new RelayBackpressure({ maxSocketBytes: 8, maxSessionBytes: 8, maxTotalBytes: 12 });
    expect(queue.send("dropped", "room", fakeSocket(0), new Uint8Array(1))).toBe(false);
    expect(queue.send("one", "room", fakeSocket(), new Uint8Array(6))).toBe(true);
    expect(queue.send("two", "room", fakeSocket(), new Uint8Array(1))).toBe(false);
    expect(queue.send("three", "room-2", fakeSocket(), new Uint8Array(2))).toBe(true);
    expect(queue.send("four", "room-3", fakeSocket(), new Uint8Array(1))).toBe(false);
    queue.remove("one");
    expect(queue.send("four", "room-3", fakeSocket(1), new Uint8Array(1))).toBe(true);
  });

  test("accounts for actual native drain before the delayed drain callback", () => {
    const queue = new RelayBackpressure({ maxSocketBytes: 8, maxSessionBytes: 8, maxTotalBytes: 8 });
    const first = fakeSocket();
    expect(queue.send("one", "room-a", first, new Uint8Array(6))).toBe(true);
    first.buffered = 2;
    expect(queue.send("two", "room-b", fakeSocket(), new Uint8Array(4))).toBe(true);
    expect(queue.send("three", "room-c", fakeSocket(), new Uint8Array(1))).toBe(false);
  });
});
