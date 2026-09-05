export interface SignalingConfig {
  relayEnabled?: boolean;
  roomTtlMs: number;
  maxMessageBytes: number;
  joinRateLimit: {
    maxAttempts: number;
    windowMs: number;
  };
  limits?: {
    maxPeers?: number;
    maxPeersPerClient?: number;
    maxRooms?: number;
    maxJoinRateBuckets?: number;
  };
}

export interface SignalingDependencies {
  now(): number;
  nextRoomCode(): string;
  nextRelayCredential?(): string;
}

export type RelaySignal =
  | { type: "offer" | "answer"; sdp: string }
  | {
      type: "candidate";
      candidate: string;
      sdpMid: string | null;
      sdpMLineIndex: number | null;
    };

export type ServerMessage =
  | { type: "room_created"; code: string; expiresAt: number }
  | { type: "join_waiting"; expiresAt: number }
  | { type: "join_requested" }
  | { type: "join_rejected" }
  | { type: "peer_joined"; role: "sender" | "receiver" }
  | { type: "room_expired" }
  | { type: "peer_left" }
  | { type: "join_cancelled" }
  | { type: "room_closed" }
  | { type: "relay_requested" }
  | { type: "relay_declined" }
  | { type: "relay_ready"; token: string; role: "sender" | "receiver" }
  | { type: "pong"; nonce: string }
  | { type: "signal"; signal: RelaySignal }
  | { type: "error"; code: string; message: string; retryAfterMs?: number };

export type SignalingAction =
  | { kind: "send"; peerId: string; message: ServerMessage }
  | { kind: "close"; peerId: string; code: number; reason: string }
  | {
      kind: "authorize_relay";
      roomCode: string;
      sessionId: string;
      senderToken: string;
      receiverToken: string;
      clientKeys: string[];
    }
  | { kind: "revoke_relay"; roomCode: string; sessionId: string };

interface Peer {
  id: string;
  clientKey: string;
  roomCode?: string;
  role?: "sender" | "receiver";
}

interface Room {
  code: string;
  senderId: string;
  pendingReceiverId?: string;
  receiverId?: string;
  expiresAt?: number;
  relayRequested?: boolean;
  relaySessionId?: string;
}

export class SignalingCore {
  private readonly peers = new Map<string, Peer>();
  private readonly rooms = new Map<string, Room>();
  private readonly joinAttempts = new Map<string, number[]>();
  private readonly maxPeers: number;
  private readonly maxPeersPerClient: number;
  private readonly maxRooms: number;
  private readonly maxJoinRateBuckets: number;

  constructor(
    private readonly config: SignalingConfig,
    private readonly dependencies: SignalingDependencies,
  ) {
    this.maxPeers = config.limits?.maxPeers ?? 1_024;
    this.maxPeersPerClient = config.limits?.maxPeersPerClient ?? 32;
    this.maxRooms = config.limits?.maxRooms ?? 512;
    this.maxJoinRateBuckets = config.limits?.maxJoinRateBuckets ?? 4_096;
  }

  connect(peer: { id: string; clientKey: string }): boolean {
    if (!this.peers.has(peer.id)) {
      if (this.peers.size >= this.maxPeers) return false;
      let peersForClient = 0;
      for (const connectedPeer of this.peers.values()) {
        if (connectedPeer.clientKey === peer.clientKey) peersForClient += 1;
      }
      if (peersForClient >= this.maxPeersPerClient) return false;
    }
    this.peers.set(peer.id, { ...peer });
    return true;
  }

  disconnect(peerId: string): SignalingAction[] {
    const peer = this.peers.get(peerId);
    if (!peer) return [];
    this.peers.delete(peerId);
    if (!peer.roomCode) return [];

    const room = this.rooms.get(peer.roomCode);
    if (!room) return [];

    if (room.pendingReceiverId === peerId) {
      room.pendingReceiverId = undefined;
      return [
        {
          kind: "send",
          peerId: room.senderId,
          message: { type: "join_cancelled" },
        },
      ];
    }

    this.rooms.delete(room.code);
    const otherIds = [room.senderId, room.pendingReceiverId, room.receiverId].filter(
      (id): id is string => Boolean(id) && id !== peerId,
    );
    const actions: SignalingAction[] = room.relaySessionId
      ? [{ kind: "revoke_relay", roomCode: room.code, sessionId: room.relaySessionId }]
      : [];
    for (const otherId of new Set(otherIds)) {
      const other = this.peers.get(otherId);
      if (other?.roomCode === room.code) {
        other.roomCode = undefined;
        other.role = undefined;
      }
      actions.push({
        kind: "send",
        peerId: otherId,
        message: {
          type: room.receiverId ? "peer_left" : "room_closed",
        },
      });
    }
    return actions;
  }

  sweepExpiredRooms(): SignalingAction[] {
    const actions: SignalingAction[] = [];
    const now = this.dependencies.now();
    this.sweepJoinAttempts(now);
    for (const room of this.rooms.values()) {
      if (room.expiresAt === undefined || room.expiresAt > now) continue;
      actions.push(...this.expireRoom(room));
    }
    return actions;
  }

  receive(peerId: string, payload: string | Uint8Array): SignalingAction[] {
    const peer = this.peers.get(peerId);
    if (!peer) return [];
    if (typeof payload !== "string") {
      return [
        { kind: "close", peerId, code: 1003, reason: "text messages only" },
      ];
    }
    if (new TextEncoder().encode(payload).byteLength > this.config.maxMessageBytes) {
      return [
        { kind: "close", peerId, code: 1009, reason: "message too large" },
      ];
    }

    let message: unknown;
    try {
      message = JSON.parse(payload);
    } catch {
      return [{ kind: "close", peerId, code: 1007, reason: "invalid json" }];
    }

    if (typeof message !== "object" || message === null || !("type" in message)) {
      return [this.error(peerId, "INVALID_MESSAGE", "未知的信令命令")];
    }

    if (message.type === "create_room") {
      if (peer.roomCode) {
        return [this.error(peerId, "ALREADY_IN_ROOM", "当前页面已在一次传输中")];
      }
      if (this.rooms.size >= this.maxRooms) {
        return [this.error(peerId, "ROOM_CAPACITY", "暂时无法创建传输，请稍后重试")];
      }
      let code: string | undefined;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const candidate = this.dependencies.nextRoomCode();
        if (/^\d{6}$/.test(candidate) && !this.rooms.has(candidate)) {
          code = candidate;
          break;
        }
      }
      if (!code) {
        return [this.error(peerId, "ROOM_CAPACITY", "暂时无法创建传输，请稍后重试")];
      }
      const expiresAt = this.dependencies.now() + this.config.roomTtlMs;
      this.rooms.set(code, { code, senderId: peerId, expiresAt });
      peer.roomCode = code;
      peer.role = "sender";
      return [
        {
          kind: "send",
          peerId,
          message: { type: "room_created", code, expiresAt },
        },
      ];
    }

    if (message.type === "join_room") {
      if (peer.roomCode) {
        return [this.error(peerId, "ALREADY_IN_ROOM", "当前页面已在一次传输中")];
      }
      const now = this.dependencies.now();
      const windowStart = now - this.config.joinRateLimit.windowMs;
      const attempts = (this.joinAttempts.get(peer.clientKey) ?? []).filter(
        (attemptAt) => attemptAt > windowStart,
      );
      if (attempts.length === 0) {
        this.joinAttempts.delete(peer.clientKey);
      }
      if (attempts.length >= this.config.joinRateLimit.maxAttempts) {
        this.joinAttempts.set(peer.clientKey, attempts);
        return [
          this.error(
            peerId,
            "RATE_LIMITED",
            "尝试次数过多，请稍后重试",
            attempts[0] + this.config.joinRateLimit.windowMs - now,
          ),
        ];
      }
      if (
        !this.joinAttempts.has(peer.clientKey) &&
        this.joinAttempts.size >= this.maxJoinRateBuckets
      ) {
        return [
          this.error(
            peerId,
            "RATE_LIMITED",
            "尝试次数过多，请稍后重试",
            this.config.joinRateLimit.windowMs,
          ),
        ];
      }
      attempts.push(now);
      this.joinAttempts.set(peer.clientKey, attempts);
      const code = "code" in message && typeof message.code === "string" ? message.code : "";
      const room = this.rooms.get(code);
      if (room?.expiresAt !== undefined && room.expiresAt <= now) {
        return [
          ...this.expireRoom(room),
          this.error(peerId, "ROOM_UNAVAILABLE", "接收码无效、已过期或正在使用"),
        ];
      }
      if (
        !/^\d{6}$/.test(code) ||
        !room ||
        room.pendingReceiverId ||
        room.receiverId
      ) {
        return [
          this.error(peerId, "ROOM_UNAVAILABLE", "接收码无效、已过期或正在使用"),
        ];
      }

      room.pendingReceiverId = peerId;
      peer.roomCode = code;
      peer.role = "receiver";
      return [
        {
          kind: "send",
          peerId,
          message: { type: "join_waiting", expiresAt: room.expiresAt! },
        },
        { kind: "send", peerId: room.senderId, message: { type: "join_requested" } },
      ];
    }

    if (message.type === "approve_join") {
      const room = peer.roomCode ? this.rooms.get(peer.roomCode) : undefined;
      if (room?.expiresAt !== undefined && room.expiresAt <= this.dependencies.now()) {
        return this.expireRoom(room);
      }
      if (!room || room.senderId !== peerId || !room.pendingReceiverId) {
        return [this.error(peerId, "STATE_CONFLICT", "当前没有可批准的连接请求")];
      }
      const receiverId = room.pendingReceiverId;
      room.pendingReceiverId = undefined;
      room.receiverId = receiverId;
      room.expiresAt = undefined;
      return [
        {
          kind: "send",
          peerId,
          message: { type: "peer_joined", role: "sender" },
        },
        {
          kind: "send",
          peerId: receiverId,
          message: { type: "peer_joined", role: "receiver" },
        },
      ];
    }

    if (message.type === "reject_join") {
      const room = peer.roomCode ? this.rooms.get(peer.roomCode) : undefined;
      if (!room || room.senderId !== peerId || !room.pendingReceiverId) {
        return [this.error(peerId, "STATE_CONFLICT", "当前没有可拒绝的连接请求")];
      }
      const receiverId = room.pendingReceiverId;
      const receiver = this.peers.get(receiverId);
      room.pendingReceiverId = undefined;
      if (receiver) {
        receiver.roomCode = undefined;
        receiver.role = undefined;
      }
      return [
        {
          kind: "send",
          peerId: receiverId,
          message: { type: "join_rejected" },
        },
      ];
    }

    if (message.type === "signal") {
      const room = peer.roomCode ? this.rooms.get(peer.roomCode) : undefined;
      if (room?.expiresAt !== undefined && room.expiresAt <= this.dependencies.now()) {
        return this.expireRoom(room);
      }
      const topLevelKeys = Object.keys(message);
      if (
        topLevelKeys.length !== 2 ||
        !topLevelKeys.includes("type") ||
        !topLevelKeys.includes("signal")
      ) {
        return [
          this.error(peerId, "INVALID_MESSAGE", "连接信息包含不允许的字段"),
        ];
      }
      if (!room || !room.receiverId || !peer.role) {
        return [this.error(peerId, "STATE_CONFLICT", "连接尚未获得双方确认")];
      }
      const signal = "signal" in message ? message.signal : undefined;
      if (typeof signal !== "object" || signal === null || !("type" in signal)) {
        return [this.error(peerId, "INVALID_MESSAGE", "连接信息格式无效")];
      }

      let relaySignal: RelaySignal;
      if (signal.type === "candidate") {
        const candidate = "candidate" in signal ? signal.candidate : undefined;
        const sdpMid = "sdpMid" in signal ? signal.sdpMid : null;
        const sdpMLineIndex =
          "sdpMLineIndex" in signal ? signal.sdpMLineIndex : null;
        if (
          typeof candidate !== "string" ||
          (sdpMid !== null && typeof sdpMid !== "string") ||
          (sdpMLineIndex !== null && typeof sdpMLineIndex !== "number")
        ) {
          return [this.error(peerId, "INVALID_MESSAGE", "连接信息格式无效")];
        }
        relaySignal = { type: "candidate", candidate, sdpMid, sdpMLineIndex };
      } else {
        const sdp = "sdp" in signal ? signal.sdp : undefined;
        if (
          (signal.type !== "offer" && signal.type !== "answer") ||
          typeof sdp !== "string"
        ) {
          return [this.error(peerId, "INVALID_MESSAGE", "连接信息格式无效")];
        }
        if (
          (signal.type === "offer" && peer.role !== "sender") ||
          (signal.type === "answer" && peer.role !== "receiver")
        ) {
          return [
            this.error(peerId, "ROLE_VIOLATION", "当前角色不能发送此类连接信息"),
          ];
        }
        relaySignal = { type: signal.type, sdp };
      }
      const targetId = peer.role === "sender" ? room.receiverId : room.senderId;
      return [
        {
          kind: "send",
          peerId: targetId,
          message: { type: "signal", signal: relaySignal },
        },
      ];
    }

    if (message.type === "request_relay") {
      if (this.config.relayEnabled === false) {
        return [this.error(peerId, "RELAY_DISABLED", "本地中转已关闭，请使用局域网直连")];
      }
      const room = peer.roomCode ? this.rooms.get(peer.roomCode) : undefined;
      if (!room?.receiverId || room.senderId !== peerId || room.relayRequested || room.relaySessionId) {
        return [this.error(peerId, "STATE_CONFLICT", "当前不能申请本地中转")];
      }
      room.relayRequested = true;
      return [{ kind: "send", peerId: room.receiverId, message: { type: "relay_requested" } }];
    }

    if (message.type === "reject_relay") {
      const room = peer.roomCode ? this.rooms.get(peer.roomCode) : undefined;
      if (!room?.relayRequested || room.receiverId !== peerId) {
        return [this.error(peerId, "STATE_CONFLICT", "当前没有待确认的中转申请")];
      }
      room.relayRequested = false;
      return [{ kind: "send", peerId: room.senderId, message: { type: "relay_declined" } }];
    }

    if (message.type === "approve_relay") {
      if (this.config.relayEnabled === false) {
        return [this.error(peerId, "RELAY_DISABLED", "本地中转已关闭，请使用局域网直连")];
      }
      const room = peer.roomCode ? this.rooms.get(peer.roomCode) : undefined;
      const nextCredential = this.dependencies.nextRelayCredential;
      if (!room?.relayRequested || room.receiverId !== peerId || room.relaySessionId || !nextCredential) {
        return [this.error(peerId, "RELAY_UNAVAILABLE", "本地中转目前不可用")];
      }
      room.relayRequested = false;
      const sessionId = nextCredential();
      const senderToken = nextCredential();
      const receiverToken = nextCredential();
      room.relaySessionId = sessionId;
      return [
        {
          kind: "authorize_relay", roomCode: room.code, sessionId, senderToken, receiverToken,
          clientKeys: [...new Set([this.peers.get(room.senderId)!.clientKey, peer.clientKey])],
        },
        {
          kind: "send",
          peerId: room.senderId,
          message: { type: "relay_ready", token: senderToken, role: "sender" },
        },
        {
          kind: "send",
          peerId,
          message: { type: "relay_ready", token: receiverToken, role: "receiver" },
        },
      ];
    }

    if (message.type === "leave") {
      const actions = this.disconnect(peerId);
      this.connect({ id: peer.id, clientKey: peer.clientKey });
      return actions;
    }

    if (message.type === "ping") {
      const nonce = "nonce" in message ? message.nonce : undefined;
      if (typeof nonce !== "string" || nonce.length > 64) {
        return [this.error(peerId, "INVALID_MESSAGE", "心跳信息格式无效")];
      }
      return [{ kind: "send", peerId, message: { type: "pong", nonce } }];
    }

    return [this.error(peerId, "INVALID_MESSAGE", "未知的信令命令")];
  }

  relayEnded(roomCode: string, sessionId: string, errorCode?: string): SignalingAction[] {
    const room = this.rooms.get(roomCode);
    if (!room || room.relaySessionId !== sessionId) return [];
    room.relaySessionId = undefined;
    room.relayRequested = false;
    if (!errorCode) return [];
    const message = errorCode === "RELAY_TIMEOUT"
      ? "本地中转等待超时，请重新连接"
      : errorCode === "RELAY_LIMIT"
        ? "本地中转已达到容量限制，请稍后重试"
        : "本地中转连接已关闭，请重新连接";
    return [room.senderId, room.receiverId]
      .filter((id): id is string => Boolean(id))
      .map((id) => this.error(id, errorCode, message));
  }

  private expireRoom(room: Room): SignalingAction[] {
    this.rooms.delete(room.code);
    const participantIds = [
      room.senderId,
      room.pendingReceiverId,
      room.receiverId,
    ].filter((id): id is string => Boolean(id));
    const actions: SignalingAction[] = room.relaySessionId
      ? [{ kind: "revoke_relay", roomCode: room.code, sessionId: room.relaySessionId }]
      : [];
    for (const participantId of new Set(participantIds)) {
      const participant = this.peers.get(participantId);
      if (participant?.roomCode === room.code) {
        participant.roomCode = undefined;
        participant.role = undefined;
      }
      actions.push({
        kind: "send",
        peerId: participantId,
        message: { type: "room_expired" },
      });
    }
    return actions;
  }

  private sweepJoinAttempts(now: number): void {
    const windowStart = now - this.config.joinRateLimit.windowMs;
    for (const [clientKey, storedAttempts] of this.joinAttempts) {
      const attempts = storedAttempts.filter((attemptAt) => attemptAt > windowStart);
      if (attempts.length === 0) {
        this.joinAttempts.delete(clientKey);
      } else if (attempts.length !== storedAttempts.length) {
        this.joinAttempts.set(clientKey, attempts);
      }
    }
  }

  private error(
    peerId: string,
    code: string,
    message: string,
    retryAfterMs?: number,
  ): SignalingAction {
    return {
      kind: "send",
      peerId,
      message:
        retryAfterMs === undefined
          ? { type: "error", code, message }
          : { type: "error", code, message, retryAfterMs },
    };
  }
}
