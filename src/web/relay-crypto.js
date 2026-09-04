const HELLO = 0;
const ENCRYPTED = 1;
const TEXT = 0;
const BINARY = 1;

function counterBytes(counter) {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, counter);
  return bytes;
}

function readCounter(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0);
}

export class RelayCipher {
  constructor(naclImpl = globalThis.nacl) {
    if (!naclImpl?.box?.keyPair || !naclImpl?.randomBytes) {
      throw new Error("relay cryptography unavailable");
    }
    this.nacl = naclImpl;
    this.keyPair = naclImpl.box.keyPair();
    this.localPrefix = naclImpl.randomBytes(16);
    this.sendCounter = 0n;
    this.receivedCounter = -1n;
    this.sharedKey = null;
    this.peerPrefix = null;
  }

  createHello() {
    const frame = new Uint8Array(49);
    frame[0] = HELLO;
    frame.set(this.keyPair.publicKey, 1);
    frame.set(this.localPrefix, 33);
    return frame;
  }

  acceptHello(value) {
    const frame = value instanceof Uint8Array ? value : new Uint8Array(value);
    if (frame.byteLength !== 49 || frame[0] !== HELLO) throw new Error("invalid relay hello");
    this.sharedKey = this.nacl.box.before(frame.slice(1, 33), this.keyPair.secretKey);
    this.peerPrefix = frame.slice(33, 49);
    this.keyPair.secretKey.fill(0);
  }

  seal(value) {
    if (!this.sharedKey) throw new Error("relay key exchange incomplete");
    const isText = typeof value === "string";
    const content = isText
      ? new TextEncoder().encode(value)
      : new Uint8Array(value instanceof ArrayBuffer ? value : value.buffer, value.byteOffset ?? 0, value.byteLength);
    const message = new Uint8Array(content.byteLength + 1);
    message[0] = isText ? TEXT : BINARY;
    message.set(content, 1);
    const nonce = new Uint8Array(24);
    nonce.set(this.localPrefix, 0);
    nonce.set(counterBytes(this.sendCounter), 16);
    this.sendCounter += 1n;
    const encrypted = this.nacl.box.after(message, nonce, this.sharedKey);
    const frame = new Uint8Array(1 + nonce.byteLength + encrypted.byteLength);
    frame[0] = ENCRYPTED;
    frame.set(nonce, 1);
    frame.set(encrypted, 25);
    return frame;
  }

  open(value) {
    if (!this.sharedKey || !this.peerPrefix) throw new Error("relay key exchange incomplete");
    const frame = value instanceof Uint8Array ? value : new Uint8Array(value);
    if (frame.byteLength < 42 || frame[0] !== ENCRYPTED) throw new Error("invalid encrypted relay frame");
    const nonce = frame.slice(1, 25);
    if (!this.nacl.verify(nonce.slice(0, 16), this.peerPrefix)) throw new Error("invalid relay nonce");
    const counter = readCounter(nonce.slice(16));
    if (counter <= this.receivedCounter) throw new Error("replayed relay frame");
    const opened = this.nacl.box.open.after(frame.slice(25), nonce, this.sharedKey);
    if (!opened) throw new Error("relay frame authentication failed");
    this.receivedCounter = counter;
    if (opened[0] === TEXT) return new TextDecoder().decode(opened.slice(1));
    if (opened[0] === BINARY) return opened.slice(1).buffer;
    throw new Error("invalid relay payload type");
  }

  destroy() {
    this.sharedKey?.fill(0);
    this.keyPair.secretKey.fill(0);
    this.localPrefix.fill(0);
    this.peerPrefix?.fill(0);
    this.sharedKey = null;
  }
}
