const DIRECT_CANDIDATE_TYPES = new Set(["host", "srflx", "prflx"]);
const CANDIDATE_TYPES = new Set([...DIRECT_CANDIDATE_TYPES, "relay"]);
const CONNECTION_STATES = new Set(["new", "connecting", "connected", "disconnected", "failed", "closed"]);
const ICE_STATES = new Set(["new", "checking", "connected", "completed", "disconnected", "failed", "closed"]);
const SIGNALING_STATES = new Map([[0, "connecting"], [1, "open"], [2, "closing"], [3, "closed"]]);
const DIAGNOSTIC_STAGES = new Set([
  "idle", "connecting_signal", "waiting_peer", "joining_room", "waiting_approval", "finding_route",
  "verifying_channel", "ready", "direct_failed", "failed",
]);
const DIAGNOSTIC_ERRORS = new Set([
  "UNKNOWN", "SIGNAL_OFFLINE", "ROOM_NOT_FOUND", "ROOM_EXPIRED", "PEER_REJECTED", "PEER_LEFT",
  "DIRECT_TIMEOUT", "DIRECT_UNSAFE_ROUTE", "DIRECT_STATS_UNAVAILABLE", "RTC_NEGOTIATION_FAILED",
  "DIRECT_CONNECTION_FAILED", "DIRECT_CONNECTION_CLOSED", "DIRECT_CHANNEL_CLOSED", "DIRECT_CHANNEL_ERROR",
  "RELAY_DECLINED", "RELAY_DISABLED", "RELAY_UNAVAILABLE", "RELAY_LIMIT", "RELAY_TIMEOUT", "RELAY_AUTH_FAILED",
  "INVALID_SERVER_MESSAGE", "INVALID_MESSAGE", "ALREADY_IN_ROOM", "ROOM_CAPACITY", "STATE_CONFLICT",
  "ROLE_VIOLATION", "RATE_LIMITED", "HEARTBEAT_TIMEOUT",
]);
const SIGNAL_DIAGNOSTIC_ERRORS = new Map([
  ["room_expired", "ROOM_EXPIRED"], ["join_rejected", "PEER_REJECTED"],
  ["peer_left", "PEER_LEFT"], ["room_closed", "PEER_LEFT"], ["relay_declined", "RELAY_DECLINED"],
]);

function knownValue(values, value) {
  return values.has(value) ? value : "unknown";
}

export class PeerSession {
  constructor(options = {}) {
    this.WebSocketImpl = options.WebSocketImpl ?? globalThis.WebSocket;
    this.RTCPeerConnectionImpl =
      options.RTCPeerConnectionImpl ?? globalThis.RTCPeerConnection;
    this.location = options.location ?? globalThis.location;
    this.onEvent = options.onEvent ?? (() => {});
    this.setIntervalImpl = options.setIntervalImpl ?? globalThis.setInterval.bind(globalThis);
    this.clearIntervalImpl = options.clearIntervalImpl ?? globalThis.clearInterval.bind(globalThis);
    this.setTimeoutImpl = options.setTimeoutImpl ?? globalThis.setTimeout.bind(globalThis);
    this.clearTimeoutImpl = options.clearTimeoutImpl ?? globalThis.clearTimeout.bind(globalThis);
    this.heartbeatMs = options.heartbeatMs ?? 15_000;
    this.now = options.now ?? (() => globalThis.performance.now());
    this.socket = null;
    this.peer = null;
    this.channel = null;
    this.role = null;
    this.pendingCandidates = [];
    this.heartbeatTimer = null;
    this.heartbeatSequence = 0;
    this.directSlowTimer = null;
    this.directTimeoutTimer = null;
    this.generation = 0;
    this.connectPromise = null;
    this.rejectConnect = null;
    this.directGeneration = 0;
    this.directState = "closed";
    this.directStartedAt = 0;
    this.resetDiagnostic();
  }

  connect() {
    if (this.socket?.readyState === 1) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;
    const generation = ++this.generation;
    this.resetDiagnostic();
    this.emit({ type: "signaling", state: "connecting" });
    if (this.generation !== generation) return Promise.reject(new Error("signaling connection cancelled"));
    const scheme = this.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new this.WebSocketImpl(`${scheme}//${this.location.host}/ws`);
    this.socket = socket;
    const isCurrent = () => this.generation === generation && this.socket === socket;
    this.connectPromise = new Promise((resolve, reject) => {
      this.rejectConnect = reject;
      let opened = false;
      const finish = (error, closeSocket) => {
        if (!isCurrent()) return;
        this.socket = null;
        this.connectPromise = null;
        this.rejectConnect = null;
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        this.stopHeartbeat();
        reject(error);
        if (closeSocket) {
          try { socket.close(); } catch { /* Local connection cleanup is complete. */ }
        }
        try {
          this.emit({ type: "signaling", state: "offline" });
        } finally {
          // A completed UI can ignore offline, but the retired service must not
          // leave a browser-to-browser channel or RTC deadline running.
          this.closeDirect();
        }
      };
      socket.onopen = () => {
        if (!isCurrent() || opened) return;
        opened = true;
        this.startHeartbeat();
        this.emit({ type: "signaling", state: "online" });
        if (!isCurrent()) return;
        this.rejectConnect = null;
        resolve();
      };
      socket.onerror = () => {
        finish(new Error("signaling unavailable"), true);
      };
      socket.onclose = () => {
        finish(new Error("signaling closed before connection completed"), false);
      };
      socket.onmessage = (event) => {
        if (!isCurrent() || typeof event.data !== "string") return;
        try {
          this.handleServerMessage(JSON.parse(event.data));
        } catch {
          if (isCurrent()) this.emit({ type: "error", code: "INVALID_SERVER_MESSAGE" });
        }
      };
    });
    return this.connectPromise;
  }

  createRoom() {
    this.role = "sender";
    this.send({ type: "create_room" });
  }

  joinRoom(code) {
    this.role = "receiver";
    this.send({ type: "join_room", code });
    // A new lookup owns new failure evidence even when it reuses the same socket.
    this.setDiagnosticPhase("joining_room", { restart: true });
  }

  approveJoin() {
    this.send({ type: "approve_join" });
  }

  rejectJoin() {
    this.send({ type: "reject_join" });
    this.setDiagnosticPhase("waiting_peer");
  }

  requestRelay() {
    this.send({ type: "request_relay" });
  }

  approveRelay() {
    this.send({ type: "approve_relay" });
  }

  rejectRelay() {
    this.send({ type: "reject_relay" });
  }

  leave() {
    this.generation += 1;
    this.stopHeartbeat();
    this.closeDirect();
    this.rejectConnect?.(new Error("signaling connection cancelled"));
    this.rejectConnect = null;
    this.connectPromise = null;
    const socket = this.socket;
    this.socket = null;
    this.role = null;
    this.pendingCandidates.length = 0;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      if (socket.readyState === 1) {
        try { socket.send(JSON.stringify({ type: "leave" })); } catch { /* Continue local cleanup. */ }
      }
    }
    socket?.close?.();
  }

  // Retire only the RTC attempt; signaling, its heartbeat and room remain usable.
  closeDirect() {
    this.retireDirect();
  }

  failDirect(code, details = {}, attempt = this.directGeneration) {
    if (attempt !== this.directGeneration || this.directState === "closed") return;
    this.retireDirect({
      type: "direct_failed",
      code,
      elapsedMs: Math.max(0, Math.round(this.now() - this.directStartedAt)),
      ...details,
    });
  }

  retireDirect(failure) {
    this.captureDiagnosticState();
    if (!failure) this.freezeDiagnostic();
    this.directGeneration += 1;
    this.directState = "closed";
    this.clearDirectDeadlines();
    const channel = this.channel;
    const peer = this.peer;
    this.channel = null;
    this.peer = null;
    this.pendingCandidates.length = 0;
    if (channel) {
      channel.onopen = null;
      channel.onclose = null;
      channel.onerror = null;
      channel.onmessage = null;
    }
    if (peer) {
      peer.onicecandidate = null;
      peer.onconnectionstatechange = null;
      peer.oniceconnectionstatechange = null;
      peer.ondatachannel = null;
    }
    // Let the owner retire idle engines before the RTC close reaches listeners.
    try {
      if (failure) this.emit(failure);
    } finally {
      try { channel?.close?.(); } catch { /* Continue RTC cleanup. */ }
      try { peer?.close?.(); } catch { /* The attempt is already retired. */ }
    }
  }

  handleServerMessage(message) {
    const generation = this.generation;
    if (!message || typeof message !== "object" || typeof message.type !== "string") {
      this.emit({ type: "error", code: "INVALID_SERVER_MESSAGE" });
      return;
    }
    this.emit(message);
    if (generation !== this.generation) return;
    if (message.type === "peer_joined") {
      this.role = message.role;
      void this.startPeer(message.role);
    }
    if (message.type === "signal") {
      const attempt = this.directGeneration;
      void this.handleSignal(message.signal).catch(() => {
        if (generation === this.generation) {
          this.failDirect("RTC_NEGOTIATION_FAILED", { reason: "negotiation_failed" }, attempt);
        }
      });
    }
  }

  startDirectDeadlines() {
    this.clearDirectDeadlines();
    const generation = this.generation;
    const attempt = this.directGeneration;
    const isCurrent = () => generation === this.generation && attempt === this.directGeneration && this.directState === "connecting";
    this.directSlowTimer = this.setTimeoutImpl(() => {
      if (!isCurrent()) return;
      this.directSlowTimer = null;
      this.emit({ type: "direct_connection", state: "slow", elapsedMs: 8_000 });
    }, 8_000);
    this.directTimeoutTimer = this.setTimeoutImpl(() => {
      if (!isCurrent()) return;
      this.directTimeoutTimer = null;
      this.failDirect("DIRECT_TIMEOUT", { reason: "connection_timeout" }, attempt);
    }, 20_000);
    this.directSlowTimer?.unref?.();
    this.directTimeoutTimer?.unref?.();
  }

  clearDirectDeadlines() {
    if (this.directSlowTimer !== null) this.clearTimeoutImpl(this.directSlowTimer);
    if (this.directTimeoutTimer !== null) this.clearTimeoutImpl(this.directTimeoutTimer);
    this.directSlowTimer = null;
    this.directTimeoutTimer = null;
  }

  startHeartbeat() {
    this.stopHeartbeat();
    const socket = this.socket;
    const generation = this.generation;
    this.heartbeatTimer = this.setIntervalImpl(() => {
      if (generation !== this.generation || socket !== this.socket || socket?.readyState !== 1) return;
      this.heartbeatSequence += 1;
      this.send({ type: "ping", nonce: `hb-${this.heartbeatSequence}` });
    }, this.heartbeatMs);
    this.heartbeatTimer?.unref?.();
  }

  stopHeartbeat() {
    if (this.heartbeatTimer === null) return;
    this.clearIntervalImpl(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  async startPeer(role) {
    this.closeDirect();
    this.directState = "connecting";
    this.directStartedAt = this.now();
    const attempt = this.directGeneration;
    this.startDirectDeadlines();
    const generation = this.generation;
    const socket = this.socket;
    this.setDiagnosticPhase("finding_route");
    if (generation !== this.generation || attempt !== this.directGeneration) return;
    try {
      const peer = new this.RTCPeerConnectionImpl({ iceServers: [] });
      this.peer = peer;
      const isCurrent = () => this.generation === generation && this.peer === peer && this.socket === socket && this.directGeneration === attempt;
      peer.onicecandidate = (event) => {
        if (!isCurrent() || !event.candidate) return;
        this.send({
          type: "signal",
          signal: {
            type: "candidate",
            candidate: event.candidate.candidate,
            sdpMid: event.candidate.sdpMid ?? null,
            sdpMLineIndex: event.candidate.sdpMLineIndex ?? null,
          },
        });
      };
      peer.onconnectionstatechange = () => {
        if (!isCurrent()) return;
        if (peer.connectionState === "failed" || peer.connectionState === "closed") {
          this.failDirect(`DIRECT_CONNECTION_${peer.connectionState.toUpperCase()}`, { reason: `peer_${peer.connectionState}` }, attempt);
        } else {
          this.emit({ type: "peer_connection", state: peer.connectionState });
        }
      };
      peer.oniceconnectionstatechange = () => {
        if (!isCurrent()) return;
        this.publishDiagnosticPhase();
      };

      if (role === "sender") {
        this.bindChannel(
          peer.createDataChannel("dukout-transfer", { ordered: true }),
        );
        const offer = await peer.createOffer();
        if (!isCurrent()) return;
        await peer.setLocalDescription(offer);
        if (!isCurrent()) return;
        this.send({
          type: "signal",
          signal: { type: "offer", sdp: offer.sdp },
        });
        return;
      }

      peer.ondatachannel = (event) => {
        if (isCurrent()) this.bindChannel(event.channel);
        else event.channel.close?.();
      };
    } catch {
      if (generation === this.generation) {
        this.failDirect("RTC_NEGOTIATION_FAILED", { reason: "negotiation_failed" }, attempt);
      }
    }
  }

  async handleSignal(signal) {
    if (this.directState === "closed") return;
    if (!this.peer || !signal || typeof signal !== "object") {
      throw new Error("peer is not ready");
    }
    const generation = this.generation;
    const peer = this.peer;
    const socket = this.socket;
    const isCurrent = () => this.generation === generation && this.peer === peer && this.socket === socket;
    if (signal.type === "offer" && this.role === "receiver") {
      await peer.setRemoteDescription({ type: "offer", sdp: signal.sdp });
      if (!isCurrent()) return;
      await this.flushPendingCandidates(peer, generation);
      if (!isCurrent()) return;
      const answer = await peer.createAnswer();
      if (!isCurrent()) return;
      await peer.setLocalDescription(answer);
      if (!isCurrent()) return;
      this.send({
        type: "signal",
        signal: { type: "answer", sdp: answer.sdp },
      });
      return;
    }
    if (signal.type === "answer" && this.role === "sender") {
      await peer.setRemoteDescription({ type: "answer", sdp: signal.sdp });
      if (!isCurrent()) return;
      await this.flushPendingCandidates(peer, generation);
      return;
    }
    if (signal.type === "candidate") {
      const candidate = {
        candidate: signal.candidate,
        sdpMid: signal.sdpMid ?? null,
        sdpMLineIndex: signal.sdpMLineIndex ?? null,
      };
      if (!peer.remoteDescription) {
        this.pendingCandidates.push(candidate);
      } else {
        await peer.addIceCandidate(candidate);
      }
      return;
    }
    throw new Error("unexpected signal");
  }

  async flushPendingCandidates(peer = this.peer, generation = this.generation) {
    const candidates = this.pendingCandidates.splice(0);
    for (const candidate of candidates) {
      if (this.peer !== peer || this.generation !== generation) return;
      await peer.addIceCandidate(candidate);
    }
  }

  bindChannel(channel) {
    const generation = this.generation;
    this.channel = channel;
    const isCurrent = () => generation === this.generation && channel === this.channel;
    channel.binaryType = "arraybuffer";
    channel.onopen = () => {
      if (!isCurrent()) return;
      this.emit({ type: "data_channel", state: "open", channel });
      if (!isCurrent()) return;
      void this.inspectDirectPath().catch(() => {
        if (isCurrent()) this.failDirect("DIRECT_STATS_UNAVAILABLE", { reason: "stats_unavailable" });
      });
    };
    channel.onclose = () => { if (isCurrent()) this.failDirect("DIRECT_CHANNEL_CLOSED", { reason: "channel_closed" }); };
    channel.onerror = () => { if (isCurrent()) this.failDirect("DIRECT_CHANNEL_ERROR", { reason: "channel_error" }); };
    channel.onmessage = (event) => { if (isCurrent()) this.emit({ type: "data", data: event.data }); };
  }

  async inspectDirectPath() {
    const peer = this.peer;
    const channel = this.channel;
    const generation = this.generation;
    const isCurrent = () => peer === this.peer && channel === this.channel && generation === this.generation;
    const stats = await peer.getStats();
    if (!isCurrent()) return;
    let pair = null;
    for (const report of stats.values()) {
      if (report.type === "transport" && report.selectedCandidatePairId) {
        pair = stats.get(report.selectedCandidatePairId) ?? null;
        break;
      }
    }
    if (!pair) {
      for (const report of stats.values()) {
        if (
          report.type === "candidate-pair" &&
          (report.selected || (report.nominated && report.state === "succeeded"))
        ) {
          pair = report;
          break;
        }
      }
    }
    if (!pair) {
      this.failDirect("DIRECT_STATS_UNAVAILABLE", { reason: "selected_pair_unavailable" });
      return;
    }
    const local = stats.get(pair.localCandidateId);
    const remote = stats.get(pair.remoteCandidateId);
    const localCandidateType = local?.candidateType ?? "unknown";
    const remoteCandidateType = remote?.candidateType ?? "unknown";
    const direct =
      DIRECT_CANDIDATE_TYPES.has(localCandidateType) &&
      DIRECT_CANDIDATE_TYPES.has(remoteCandidateType);
    if (direct) {
      this.directState = "verified";
      this.clearDirectDeadlines();
    }
    this.emit({
      type: "direct_path",
      direct,
      localCandidateType,
      remoteCandidateType,
    });
    if (!direct && isCurrent()) {
      this.failDirect("DIRECT_UNSAFE_ROUTE", { reason: "candidate_type_not_direct", localCandidateType, remoteCandidateType });
    }
  }

  send(message) {
    if (!this.socket || this.socket.readyState !== 1) {
      throw new Error("signaling socket is not open");
    }
    this.socket.send(JSON.stringify(message));
  }

  resetDiagnostic() {
    this.diagnosticStartedAt = this.now();
    this.diagnosticPhaseStartedAt = this.diagnosticStartedAt;
    this.diagnosticFrozen = null;
    this.diagnostic = {
      stage: "idle", failedStage: null, signalingState: "unknown", iceState: "unknown",
      connectionState: "unknown", localCandidateType: "unknown", remoteCandidateType: "unknown", errorCode: null,
    };
  }

  captureDiagnosticState() {
    if (this.diagnosticFrozen) return;
    if (this.socket) {
      this.diagnostic.signalingState = SIGNALING_STATES.get(this.socket.readyState) ?? "unknown";
    }
    if (this.peer) {
      this.diagnostic.iceState = knownValue(ICE_STATES, this.peer.iceConnectionState);
      this.diagnostic.connectionState = knownValue(CONNECTION_STATES, this.peer.connectionState);
    }
  }

  getDiagnosticSnapshot() {
    if (this.diagnosticFrozen) return { ...this.diagnosticFrozen };
    this.captureDiagnosticState();
    const now = this.now();
    return {
      ...this.diagnostic,
      elapsedMs: Math.max(0, Math.round(now - this.diagnosticPhaseStartedAt)),
      totalElapsedMs: Math.max(0, Math.round(now - this.diagnosticStartedAt)),
    };
  }

  freezeDiagnostic() {
    this.diagnosticFrozen ??= this.getDiagnosticSnapshot();
  }

  setDiagnosticPhase(stage, { restart = false } = {}) {
    if (!DIAGNOSTIC_STAGES.has(stage)) return;
    const previousStage = this.diagnostic.stage;
    this.diagnosticFrozen = null;
    this.diagnostic.stage = stage;
    this.diagnostic.errorCode = null;
    this.diagnostic.failedStage = null;
    if (restart || previousStage !== stage) this.diagnosticPhaseStartedAt = this.now();
    if (stage === "finding_route") {
      this.diagnostic.localCandidateType = "unknown";
      this.diagnostic.remoteCandidateType = "unknown";
      this.diagnostic.iceState = "new";
      this.diagnostic.connectionState = "new";
    }
    this.publishDiagnosticPhase();
  }

  failDiagnostic(stage, errorCode) {
    if (this.diagnosticFrozen?.errorCode) return;
    const snapshot = this.getDiagnosticSnapshot();
    this.diagnosticFrozen = {
      ...snapshot, stage, failedStage: snapshot.stage,
      errorCode: DIAGNOSTIC_ERRORS.has(errorCode) ? errorCode : "UNKNOWN",
    };
    this.diagnostic = { ...this.diagnostic, ...this.diagnosticFrozen };
    this.publishDiagnosticPhase();
  }

  publishDiagnosticPhase() {
    this.onEvent({ type: "phase", ...this.getDiagnosticSnapshot() });
  }

  trackDiagnosticEvent(event) {
    if (event.type === "signaling") {
      if (event.state === "connecting") {
        this.diagnostic.signalingState = "connecting";
        this.setDiagnosticPhase("connecting_signal");
      } else if (event.state === "online") {
        this.setDiagnosticPhase("waiting_peer");
      } else if (event.state === "offline") {
        this.diagnostic.signalingState = "closed";
        this.failDiagnostic("failed", "SIGNAL_OFFLINE");
      }
    } else if (event.type === "room_created") {
      this.setDiagnosticPhase("waiting_peer");
    } else if (event.type === "join_waiting" || event.type === "join_requested") {
      this.setDiagnosticPhase("waiting_approval");
    } else if (event.type === "data_channel" && event.state === "open") {
      this.setDiagnosticPhase("verifying_channel");
    } else if (event.type === "direct_path") {
      this.diagnostic.localCandidateType = knownValue(CANDIDATE_TYPES, event.localCandidateType);
      this.diagnostic.remoteCandidateType = knownValue(CANDIDATE_TYPES, event.remoteCandidateType);
      if (event.direct) this.setDiagnosticPhase("ready");
    } else if (event.type === "direct_failed") {
      this.failDiagnostic("direct_failed", event.code);
    } else if (event.type === "peer_connection") {
      this.publishDiagnosticPhase();
    } else if (event.type === "error") {
      this.failDiagnostic("failed", event.code === "ROOM_UNAVAILABLE" ? "ROOM_NOT_FOUND" : event.code);
    } else {
      const errorCode = SIGNAL_DIAGNOSTIC_ERRORS.get(event.type);
      if (errorCode) this.failDiagnostic("failed", errorCode);
    }
  }

  emit(event) {
    this.trackDiagnosticEvent(event);
    this.onEvent(event);
  }
}
