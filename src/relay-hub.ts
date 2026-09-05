export interface RelayHubOptions {
  now(): number;
  credentialTtlMs: number;
  maxFrameBytes: number;
  handshakeTimeoutMs?: number;
  idleTimeoutMs?: number;
  maxSessions?: number;
  maxSessionsPerClient?: number;
}

export const RELAY_DEFAULTS = {
  credentialTtlMs: 60_000,
  handshakeTimeoutMs: 30_000,
  idleTimeoutMs: 120_000,
  maxFrameBytes: 256 * 1024,
  maxSessions: 64,
  maxSessionsPerClient: 8,
} as const;

type RelayRole = "sender" | "receiver";

export interface RelayClosure {
  sessionId: string;
  roomCode: string;
  connectionIds: string[];
  reason: string;
}

interface RelaySession {
  id: string;
  roomCode: string;
  clientKeys: string[];
  expiresAt: number;
  handshakeExpiresAt?: number;
  lastActivityAt: number;
  tokens: Record<RelayRole, string | undefined>;
  connections: Partial<Record<RelayRole, string>>;
}

export class RelayHub {
  private readonly sessions = new Map<string, RelaySession>();
  private readonly roomIndex = new Map<string, string>();
  private readonly tokenIndex = new Map<string, { sessionId: string; role: RelayRole }>();
  private readonly connectionIndex = new Map<string, { sessionId: string; role: RelayRole }>();

  private readonly config: { [K in keyof typeof RELAY_DEFAULTS]: number };

  constructor(private readonly options: RelayHubOptions) {
    this.config = { ...RELAY_DEFAULTS, ...options };
    for (const key of Object.keys(RELAY_DEFAULTS) as (keyof typeof RELAY_DEFAULTS)[]) {
      if (!Number.isSafeInteger(this.config[key]) || this.config[key] <= 0) {
        throw new Error(`${key} must be a positive integer`);
      }
    }
  }

  authorize(
    sessionId: string,
    senderToken: string,
    receiverToken: string,
    roomCode = sessionId,
    clientKeys: string[] = [],
  ): boolean {
    const clients = [...new Set(clientKeys)];
    if (
      this.sessions.has(sessionId) || this.roomIndex.has(roomCode) ||
      this.sessions.size >= this.config.maxSessions ||
      senderToken === receiverToken || this.tokenIndex.has(senderToken) || this.tokenIndex.has(receiverToken)
    ) return false;
    for (const clientKey of clients) {
      let count = 0;
      for (const existing of this.sessions.values()) {
        if (existing.clientKeys.includes(clientKey)) count += 1;
      }
      if (count >= this.config.maxSessionsPerClient) return false;
    }
    const now = this.options.now();
    const session: RelaySession = {
      id: sessionId,
      roomCode,
      clientKeys: clients,
      expiresAt: now + this.config.credentialTtlMs,
      lastActivityAt: now,
      tokens: { sender: senderToken, receiver: receiverToken },
      connections: {},
    };
    this.sessions.set(sessionId, session);
    this.roomIndex.set(roomCode, sessionId);
    this.tokenIndex.set(senderToken, { sessionId, role: "sender" });
    this.tokenIndex.set(receiverToken, { sessionId, role: "receiver" });
    return true;
  }

  claim(token: string, connectionId: string): { sessionId: string; role: RelayRole } | null {
    const indexed = this.tokenIndex.get(token);
    if (!indexed || this.connectionIndex.has(connectionId)) return null;
    const session = this.sessions.get(indexed.sessionId);
    if (!session || this.expired(session) || session.connections[indexed.role]) return null;
    this.tokenIndex.delete(token);
    session.tokens[indexed.role] = undefined;
    session.connections[indexed.role] = connectionId;
    session.handshakeExpiresAt ??= this.options.now() + this.config.handshakeTimeoutMs;
    session.lastActivityAt = this.options.now();
    this.connectionIndex.set(connectionId, indexed);
    return indexed;
  }

  sessionIdFor(connectionId: string): string | null {
    return this.connectionIndex.get(connectionId)?.sessionId ?? null;
  }

  counterpart(connectionId: string): string | null {
    const indexed = this.connectionIndex.get(connectionId);
    if (!indexed) return null;
    const session = this.sessions.get(indexed.sessionId);
    if (!session) return null;
    const opposite: RelayRole = indexed.role === "sender" ? "receiver" : "sender";
    return session.connections[opposite] ?? null;
  }

  touch(connectionId: string): boolean {
    const sessionId = this.connectionIndex.get(connectionId)?.sessionId;
    const session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!session || this.expired(session)) return false;
    session.lastActivityAt = this.options.now();
    return true;
  }

  validateFrame(frame: string | ArrayBuffer | Uint8Array): void {
    const size = typeof frame === "string" ? new TextEncoder().encode(frame).byteLength : frame.byteLength;
    if (size > this.config.maxFrameBytes) throw new Error("relay frame too large");
  }

  disconnect(connectionId: string, reason = "RELAY_CLOSED"): RelayClosure | null {
    const sessionId = this.connectionIndex.get(connectionId)?.sessionId;
    return sessionId ? this.revoke(sessionId, reason) : null;
  }

  revokeRoom(roomCode: string, reason = "RELAY_CLOSED", expectedSessionId?: string): RelayClosure | null {
    const sessionId = this.roomIndex.get(roomCode);
    if (!sessionId || (expectedSessionId && sessionId !== expectedSessionId)) return null;
    return this.revoke(sessionId, reason);
  }

  sweep(): RelayClosure[] {
    const closures: RelayClosure[] = [];
    for (const session of this.sessions.values()) {
      if (this.expired(session)) closures.push(this.revoke(session.id, "RELAY_TIMEOUT")!);
    }
    return closures;
  }

  private expired(session: RelaySession): boolean {
    const now = this.options.now();
    if (session.connections.sender && session.connections.receiver) {
      return session.lastActivityAt + this.config.idleTimeoutMs <= now;
    }
    return session.expiresAt <= now ||
      (session.handshakeExpiresAt !== undefined && session.handshakeExpiresAt <= now);
  }

  private revoke(sessionId: string, reason: string): RelayClosure | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    const connectionIds = Object.values(session.connections).filter((id): id is string => Boolean(id));
    for (const token of Object.values(session.tokens)) if (token) this.tokenIndex.delete(token);
    for (const id of connectionIds) this.connectionIndex.delete(id);
    this.sessions.delete(session.id);
    this.roomIndex.delete(session.roomCode);
    return { sessionId: session.id, roomCode: session.roomCode, connectionIds, reason };
  }
}
