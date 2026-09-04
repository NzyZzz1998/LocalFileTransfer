interface RelayHubOptions {
  now(): number;
  credentialTtlMs: number;
  maxFrameBytes: number;
}

type RelayRole = "sender" | "receiver";

interface RelaySession {
  id: string;
  expiresAt: number;
  tokens: Record<RelayRole, string | undefined>;
  connections: Partial<Record<RelayRole, string>>;
}

export class RelayHub {
  private readonly sessions = new Map<string, RelaySession>();
  private readonly tokenIndex = new Map<string, { sessionId: string; role: RelayRole }>();
  private readonly connectionIndex = new Map<string, { sessionId: string; role: RelayRole }>();

  constructor(private readonly options: RelayHubOptions) {}

  authorize(sessionId: string, senderToken: string, receiverToken: string): void {
    const session: RelaySession = {
      id: sessionId,
      expiresAt: this.options.now() + this.options.credentialTtlMs,
      tokens: { sender: senderToken, receiver: receiverToken },
      connections: {},
    };
    this.sessions.set(sessionId, session);
    this.tokenIndex.set(senderToken, { sessionId, role: "sender" });
    this.tokenIndex.set(receiverToken, { sessionId, role: "receiver" });
  }

  claim(token: string, connectionId: string): { sessionId: string; role: RelayRole } | null {
    const indexed = this.tokenIndex.get(token);
    if (!indexed) return null;
    const session = this.sessions.get(indexed.sessionId);
    if (!session || session.expiresAt <= this.options.now() || session.connections[indexed.role]) {
      this.tokenIndex.delete(token);
      return null;
    }
    this.tokenIndex.delete(token);
    session.tokens[indexed.role] = undefined;
    session.connections[indexed.role] = connectionId;
    this.connectionIndex.set(connectionId, indexed);
    return indexed;
  }

  counterpart(connectionId: string): string | null {
    const indexed = this.connectionIndex.get(connectionId);
    if (!indexed) return null;
    const session = this.sessions.get(indexed.sessionId);
    if (!session) return null;
    const opposite: RelayRole = indexed.role === "sender" ? "receiver" : "sender";
    return session.connections[opposite] ?? null;
  }

  validateFrame(frame: string | ArrayBuffer | Uint8Array): void {
    const size =
      typeof frame === "string"
        ? new TextEncoder().encode(frame).byteLength
        : frame instanceof Uint8Array
          ? frame.byteLength
          : frame.byteLength;
    if (size > this.options.maxFrameBytes) throw new Error("relay frame too large");
  }

  disconnect(connectionId: string): void {
    const indexed = this.connectionIndex.get(connectionId);
    if (!indexed) return;
    const session = this.sessions.get(indexed.sessionId);
    if (!session) return;
    for (const token of Object.values(session.tokens)) if (token) this.tokenIndex.delete(token);
    for (const id of Object.values(session.connections)) if (id) this.connectionIndex.delete(id);
    this.sessions.delete(session.id);
  }

  sweep(): void {
    const now = this.options.now();
    for (const session of this.sessions.values()) {
      if (session.expiresAt > now || Object.keys(session.connections).length > 0) continue;
      for (const token of Object.values(session.tokens)) if (token) this.tokenIndex.delete(token);
      this.sessions.delete(session.id);
    }
  }
}
