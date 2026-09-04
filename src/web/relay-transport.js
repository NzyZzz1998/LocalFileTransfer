import { RelayCipher } from "./relay-crypto.js";

export class RelayTransport {
  constructor({ token, WebSocketImpl = globalThis.WebSocket, location = globalThis.location, naclImpl = globalThis.nacl }) {
    this.token = token;
    this.WebSocketImpl = WebSocketImpl;
    this.location = location;
    this.cipher = new RelayCipher(naclImpl);
    this.socket = null;
    this.readyState = "connecting";
    this.binaryType = "arraybuffer";
    this.bufferedAmountLowThreshold = 0;
    this.listeners = new Map();
    this.pendingMessages = [];
  }

  get bufferedAmount() {
    return this.socket?.bufferedAmount ?? 0;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
    if (type === "message" && this.pendingMessages.length > 0) {
      const pending = this.pendingMessages.splice(0);
      queueMicrotask(() => pending.forEach((event) => listener(event)));
    }
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type, event = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  connect() {
    const scheme = this.location.protocol === "https:" ? "wss:" : "ws:";
    this.socket = new this.WebSocketImpl(`${scheme}//${this.location.host}/relay?token=${encodeURIComponent(this.token)}`);
    this.socket.binaryType = "arraybuffer";
    return new Promise((resolve, reject) => {
      let settled = false;
      this.socket.onmessage = (event) => {
        try {
          if (typeof event.data === "string") {
            const message = JSON.parse(event.data);
            if (message.type === "relay_open") this.socket.send(this.cipher.createHello());
            return;
          }
          if (this.readyState === "connecting") {
            this.cipher.acceptHello(event.data);
            this.readyState = "open";
            settled = true;
            resolve(this);
            this.dispatch("open");
            return;
          }
          const messageEvent = { data: this.cipher.open(event.data) };
          if ((this.listeners.get("message")?.size ?? 0) === 0) this.pendingMessages.push(messageEvent);
          else this.dispatch("message", messageEvent);
        } catch (error) {
          if (!settled) reject(error);
          this.close();
        }
      };
      this.socket.onerror = () => {
        if (!settled) reject(new Error("relay unavailable"));
      };
      this.socket.onclose = () => {
        const wasOpen = this.readyState === "open";
        this.readyState = "closed";
        this.cipher.destroy();
        if (!settled) reject(new Error("relay closed before key exchange"));
        if (wasOpen) this.dispatch("close");
      };
    });
  }

  send(value) {
    if (this.readyState !== "open" || this.socket?.readyState !== 1) {
      throw new Error("relay transport is not open");
    }
    this.socket.send(this.cipher.seal(value));
    if (this.bufferedAmount > this.bufferedAmountLowThreshold) this.waitForLowBuffer();
  }

  waitForLowBuffer() {
    if (this.readyState !== "open") return;
    if (this.bufferedAmount <= this.bufferedAmountLowThreshold) {
      this.dispatch("bufferedamountlow");
      return;
    }
    setTimeout(() => this.waitForLowBuffer(), 20);
  }

  close() {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.cipher.destroy();
    this.socket?.close?.();
  }
}
