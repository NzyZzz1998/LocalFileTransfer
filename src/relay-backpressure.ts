export const RELAY_QUEUE_DEFAULTS = {
  maxSocketBytes: 4 * 1024 * 1024,
  maxSessionBytes: 8 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
} as const;

export interface RelayQueueOptions {
  maxSocketBytes: number;
  maxSessionBytes: number;
  maxTotalBytes: number;
}

interface RelaySocket {
  getBufferedAmount(): number;
  send(frame: string | Uint8Array): number;
}

/** Tracks Bun's native queues only; -1 means accepted, never retry that frame. */
export class RelayBackpressure {
  private readonly pending = new Map<string, { sessionId: string; socket: RelaySocket }>();

  constructor(private readonly options: RelayQueueOptions = RELAY_QUEUE_DEFAULTS) {
    for (const value of Object.values(options)) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error("relay queue limits must be positive integers");
    }
  }

  send(connectionId: string, sessionId: string, socket: RelaySocket, frame: string | Uint8Array): boolean {
    const frameBytes = typeof frame === "string" ? new TextEncoder().encode(frame).byteLength : frame.byteLength;
    // Reserve the unmasked WebSocket frame header as well as its payload before enqueueing.
    const enqueueBytes = frameBytes + (frameBytes <= 125 ? 2 : frameBytes <= 65_535 ? 4 : 10);
    const socketBytes = socket.getBufferedAmount();
    let sessionBytes = 0;
    let totalBytes = 0;
    for (const [id, entry] of this.pending) {
      const bytes = entry.socket.getBufferedAmount();
      if (bytes === 0) this.pending.delete(id);
      totalBytes += bytes;
      if (entry.sessionId === sessionId) sessionBytes += bytes;
    }
    if (
      socketBytes + enqueueBytes > this.options.maxSocketBytes ||
      sessionBytes + enqueueBytes > this.options.maxSessionBytes ||
      totalBytes + enqueueBytes > this.options.maxTotalBytes
    ) return false;
    let sent: number;
    try {
      sent = socket.send(frame);
    } catch {
      return false;
    }
    if (sent === 0 || sent < -1) return false;
    const buffered = socket.getBufferedAmount();
    if (buffered > 0 || sent === -1) this.pending.set(connectionId, { sessionId, socket });
    else this.pending.delete(connectionId);
    return buffered <= this.options.maxSocketBytes &&
      sessionBytes - socketBytes + buffered <= this.options.maxSessionBytes &&
      totalBytes - socketBytes + buffered <= this.options.maxTotalBytes;
  }

  drain(connectionId: string): void {
    const entry = this.pending.get(connectionId);
    if (entry && entry.socket.getBufferedAmount() === 0) this.pending.delete(connectionId);
  }

  remove(connectionId: string): void {
    this.pending.delete(connectionId);
  }
}
