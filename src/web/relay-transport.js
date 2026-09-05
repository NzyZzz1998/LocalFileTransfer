import { RelayCipher } from "./relay-crypto.js";

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_PENDING_MESSAGES = 64;
const DEFAULT_MAX_PENDING_BYTES = 1024 * 1024;

function relayError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function reportListenerError(error) {
  if (typeof globalThis.reportError === "function") globalThis.reportError(error);
  else console.error(error);
}

export class RelayTransport {
  constructor({
    token,
    WebSocketImpl = globalThis.WebSocket,
    location = globalThis.location,
    naclImpl = globalThis.nacl,
    handshakeTimeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS,
    maxPendingMessages = DEFAULT_MAX_PENDING_MESSAGES,
    maxPendingBytes = DEFAULT_MAX_PENDING_BYTES,
    setTimeoutImpl = globalThis.setTimeout.bind(globalThis),
    clearTimeoutImpl = globalThis.clearTimeout.bind(globalThis),
    reportErrorImpl = reportListenerError,
  }) {
    this.token = token;
    this.WebSocketImpl = WebSocketImpl;
    this.location = location;
    this.cipher = new RelayCipher(naclImpl);
    this.handshakeTimeoutMs = handshakeTimeoutMs;
    this.maxPendingMessages = maxPendingMessages;
    this.maxPendingBytes = maxPendingBytes;
    this.setTimeout = setTimeoutImpl;
    this.clearTimeout = clearTimeoutImpl;
    this.reportError = reportErrorImpl;
    this.socket = null;
    this.readyState = "connecting";
    this.binaryType = "arraybuffer";
    this.bufferedAmountLowThreshold = 0;
    this.listeners = new Map();
    this.pendingMessages = [];
    this.pendingMessageBytes = 0;
    this.flushScheduled = false;
    this.handshakeTimer = null;
    this.drainTimer = null;
    this.connectPromise = null;
    this.helloSent = false;
  }

  get bufferedAmount() {
    return this.socket?.bufferedAmount ?? 0;
  }

  addEventListener(type, listener) {
    if (this.readyState === "closed") return;
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
    if (type === "message") this.schedulePendingMessages();
  }

  removeEventListener(type, listener) {
    const listeners = this.listeners.get(type);
    listeners?.delete(listener);
    if (listeners?.size === 0) this.listeners.delete(type);
  }

  dispatch(type, event = {}) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      if (!this.listeners.get(type)?.has(listener)) continue;
      try {
        listener(event);
      } catch (error) {
        // Consumer callbacks are not part of frame authentication. Report them
        // independently so one callback cannot prevent terminal cleanup.
        try { this.reportError(error); } catch { /* Reporting must not interrupt other listeners or cleanup. */ }
      }
    }
  }

  connect({ signal } = {}) {
    if (this.readyState === "closed") {
      return Promise.reject(this.terminalError ?? relayError("RELAY_CANCELLED", "relay transport is closed"));
    }
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = new Promise((resolve, reject) => {
      this.resolveConnect = resolve;
      this.rejectConnect = reject;
    });
    if (signal?.aborted) {
      this.close();
      return this.connectPromise;
    }
    if (signal) {
      this.signal = signal;
      this.handleAbort = () => this.close();
      signal.addEventListener("abort", this.handleAbort, { once: true });
    }
    try {
      const scheme = this.location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new this.WebSocketImpl(`${scheme}//${this.location.host}/relay?token=${encodeURIComponent(this.token)}`);
      this.socket = socket;
      socket.binaryType = "arraybuffer";
      socket.onmessage = (event) => this.handleMessage(event.data);
      socket.onerror = () => this.terminate(relayError("RELAY_UNAVAILABLE", "relay connection failed"));
      socket.onclose = (event = {}) => {
        const code = /^RELAY_[A-Z_]+$/.test(event.reason ?? "") ? event.reason : "RELAY_CLOSED";
        this.terminate(relayError(code, "relay connection closed"), {
          closeSocket: false,
          emitError: code !== "RELAY_CLOSED",
          closeCode: event.code,
        });
      };
      this.handshakeTimer = this.setTimeout(() => {
        this.handshakeTimer = null;
        this.terminate(relayError("RELAY_TIMEOUT", "relay key exchange timed out"));
      }, this.handshakeTimeoutMs);
    } catch {
      this.terminate(relayError("RELAY_UNAVAILABLE", "relay connection could not be opened"));
    } finally {
      // The socket already owns the request URL; do not retain another copy of
      // its one-time credential for the rest of the transfer.
      this.token = undefined;
    }
    return this.connectPromise;
  }

  handleMessage(data) {
    if (this.readyState === "closed") return;
    let opened;
    try {
      if (typeof data === "string") {
        const message = JSON.parse(data);
        if (message.type !== "relay_open" || this.readyState !== "connecting" || this.helloSent) {
          throw new Error("unexpected plaintext relay control");
        }
        this.helloSent = true;
        this.socket.send(this.cipher.createHello());
        return;
      }
      if (this.readyState === "connecting") {
        if (!this.helloSent) throw new Error("relay key hello before relay opened");
        this.cipher.acceptHello(data);
      } else {
        opened = this.cipher.open(data);
      }
    } catch {
      this.terminate(relayError("RELAY_AUTH_FAILED", "relay frame authentication or key exchange failed"));
      return;
    }
    if (this.readyState === "connecting") {
      this.readyState = "open";
      this.clearHandshakeTimer();
      this.resolveConnect?.(this);
      this.resolveConnect = null;
      this.rejectConnect = null;
      this.dispatch("open");
      return;
    }
    const event = { data: opened };
    if (this.pendingMessages.length > 0 || (this.listeners.get("message")?.size ?? 0) === 0) {
      const bytes = typeof opened === "string" ? new TextEncoder().encode(opened).byteLength : opened.byteLength;
      if (this.pendingMessages.length >= this.maxPendingMessages || this.pendingMessageBytes + bytes > this.maxPendingBytes) {
        this.terminate(relayError("RELAY_LIMIT", "relay pending message limit exceeded"));
        return;
      }
      this.pendingMessages.push({ event, bytes });
      this.pendingMessageBytes += bytes;
      this.schedulePendingMessages();
    } else {
      this.dispatch("message", event);
    }
  }

  schedulePendingMessages() {
    if (this.flushScheduled || this.pendingMessages.length === 0 || !this.listeners.get("message")?.size) return;
    this.flushScheduled = true;
    queueMicrotask(() => {
      this.flushScheduled = false;
      while (this.readyState === "open" && this.pendingMessages.length > 0 && this.listeners.get("message")?.size) {
        const { event, bytes } = this.pendingMessages.shift();
        this.pendingMessageBytes -= bytes;
        this.dispatch("message", event);
      }
    });
  }

  send(value) {
    if (this.readyState !== "open" || this.socket?.readyState !== 1) {
      throw new Error("relay transport is not open");
    }
    try {
      this.socket.send(this.cipher.seal(value));
    } catch (error) {
      this.terminate(relayError("RELAY_UNAVAILABLE", "relay frame could not be sent"));
      throw error;
    }
    if (this.bufferedAmount > this.bufferedAmountLowThreshold) this.waitForLowBuffer();
  }

  waitForLowBuffer() {
    if (this.readyState !== "open" || this.drainTimer !== null) return;
    this.drainTimer = this.setTimeout(() => {
      this.drainTimer = null;
      if (this.readyState !== "open") return;
      if (this.bufferedAmount <= this.bufferedAmountLowThreshold) this.dispatch("bufferedamountlow");
      else this.waitForLowBuffer();
    }, 20);
  }

  clearHandshakeTimer() {
    if (this.handshakeTimer !== null) this.clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
  }

  terminate(error, { closeSocket = true, emitError = true, closeCode } = {}) {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.terminalError = error;
    this.clearHandshakeTimer();
    if (this.drainTimer !== null) this.clearTimeout(this.drainTimer);
    this.drainTimer = null;
    this.signal?.removeEventListener("abort", this.handleAbort);
    this.signal = null;
    this.handleAbort = null;
    this.token = undefined;
    this.pendingMessages.length = 0;
    this.pendingMessageBytes = 0;
    this.flushScheduled = false;
    this.cipher.destroy();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      if (closeSocket) {
        try { socket.close(); } catch { /* Local termination is already complete. */ }
      }
    }
    this.rejectConnect?.(error);
    this.resolveConnect = null;
    this.rejectConnect = null;
    const event = { code: error.code, error, closeCode };
    if (emitError) this.dispatch("error", event);
    this.dispatch("close", event);
    this.listeners.clear();
  }

  close() {
    this.terminate(relayError("RELAY_CANCELLED", "relay connection cancelled"), { emitError: false });
  }
}
