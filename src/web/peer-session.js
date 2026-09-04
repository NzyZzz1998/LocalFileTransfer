const DIRECT_CANDIDATE_TYPES = new Set(["host", "srflx", "prflx"]);

export class PeerSession {
  constructor(options = {}) {
    this.WebSocketImpl = options.WebSocketImpl ?? globalThis.WebSocket;
    this.RTCPeerConnectionImpl =
      options.RTCPeerConnectionImpl ?? globalThis.RTCPeerConnection;
    this.location = options.location ?? globalThis.location;
    this.onEvent = options.onEvent ?? (() => {});
    this.socket = null;
    this.peer = null;
    this.channel = null;
    this.role = null;
    this.pendingCandidates = [];
  }

  connect() {
    if (this.socket?.readyState === 1) return Promise.resolve();
    this.emit({ type: "signaling", state: "connecting" });
    const scheme = this.location.protocol === "https:" ? "wss:" : "ws:";
    this.socket = new this.WebSocketImpl(`${scheme}//${this.location.host}/ws`);
    return new Promise((resolve, reject) => {
      this.socket.onopen = () => {
        this.emit({ type: "signaling", state: "online" });
        resolve();
      };
      this.socket.onerror = () => {
        this.emit({ type: "signaling", state: "offline" });
        reject(new Error("signaling unavailable"));
      };
      this.socket.onclose = () => {
        this.emit({ type: "signaling", state: "offline" });
      };
      this.socket.onmessage = (event) => {
        if (typeof event.data !== "string") return;
        try {
          this.handleServerMessage(JSON.parse(event.data));
        } catch {
          this.emit({ type: "error", code: "INVALID_SERVER_MESSAGE" });
        }
      };
    });
  }

  createRoom() {
    this.role = "sender";
    this.send({ type: "create_room" });
  }

  joinRoom(code) {
    this.role = "receiver";
    this.send({ type: "join_room", code });
  }

  approveJoin() {
    this.send({ type: "approve_join" });
  }

  rejectJoin() {
    this.send({ type: "reject_join" });
  }

  leave() {
    if (this.socket?.readyState === 1) this.send({ type: "leave" });
    this.channel?.close?.();
    this.peer?.close?.();
    this.socket?.close?.();
    this.channel = null;
    this.peer = null;
    this.socket = null;
    this.role = null;
  }

  handleServerMessage(message) {
    if (!message || typeof message !== "object" || typeof message.type !== "string") {
      this.emit({ type: "error", code: "INVALID_SERVER_MESSAGE" });
      return;
    }
    this.emit(message);
    if (message.type === "peer_joined") {
      this.role = message.role;
      void this.startPeer(message.role).catch(() => {
        this.emit({ type: "error", code: "RTC_NEGOTIATION_FAILED" });
      });
    }
    if (message.type === "signal") {
      void this.handleSignal(message.signal).catch(() => {
        this.emit({ type: "error", code: "RTC_NEGOTIATION_FAILED" });
      });
    }
  }

  async startPeer(role) {
    this.peer = new this.RTCPeerConnectionImpl({ iceServers: [] });
    this.peer.onicecandidate = (event) => {
      if (!event.candidate) return;
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
    this.peer.onconnectionstatechange = () => {
      this.emit({ type: "peer_connection", state: this.peer.connectionState });
    };

    if (role === "sender") {
      this.bindChannel(
        this.peer.createDataChannel("dukout-transfer", { ordered: true }),
      );
      const offer = await this.peer.createOffer();
      await this.peer.setLocalDescription(offer);
      this.send({
        type: "signal",
        signal: { type: "offer", sdp: offer.sdp },
      });
      return;
    }

    this.peer.ondatachannel = (event) => this.bindChannel(event.channel);
  }

  async handleSignal(signal) {
    if (!this.peer || !signal || typeof signal !== "object") {
      throw new Error("peer is not ready");
    }
    if (signal.type === "offer" && this.role === "receiver") {
      await this.peer.setRemoteDescription({ type: "offer", sdp: signal.sdp });
      await this.flushPendingCandidates();
      const answer = await this.peer.createAnswer();
      await this.peer.setLocalDescription(answer);
      this.send({
        type: "signal",
        signal: { type: "answer", sdp: answer.sdp },
      });
      return;
    }
    if (signal.type === "answer" && this.role === "sender") {
      await this.peer.setRemoteDescription({ type: "answer", sdp: signal.sdp });
      await this.flushPendingCandidates();
      return;
    }
    if (signal.type === "candidate") {
      const candidate = {
        candidate: signal.candidate,
        sdpMid: signal.sdpMid ?? null,
        sdpMLineIndex: signal.sdpMLineIndex ?? null,
      };
      if (!this.peer.remoteDescription) {
        this.pendingCandidates.push(candidate);
      } else {
        await this.peer.addIceCandidate(candidate);
      }
      return;
    }
    throw new Error("unexpected signal");
  }

  async flushPendingCandidates() {
    const candidates = this.pendingCandidates.splice(0);
    for (const candidate of candidates) {
      await this.peer.addIceCandidate(candidate);
    }
  }

  bindChannel(channel) {
    this.channel = channel;
    channel.binaryType = "arraybuffer";
    channel.onopen = () => {
      this.emit({ type: "data_channel", state: "open", channel });
      void this.inspectDirectPath().catch(() => {
        this.emit({ type: "direct_path", direct: false, reason: "stats_unavailable" });
      });
    };
    channel.onclose = () => this.emit({ type: "data_channel", state: "closed" });
    channel.onmessage = (event) => this.emit({ type: "data", data: event.data });
  }

  async inspectDirectPath() {
    const stats = await this.peer.getStats();
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
    if (!pair) throw new Error("selected candidate pair unavailable");
    const local = stats.get(pair.localCandidateId);
    const remote = stats.get(pair.remoteCandidateId);
    const localCandidateType = local?.candidateType ?? "unknown";
    const remoteCandidateType = remote?.candidateType ?? "unknown";
    const direct =
      DIRECT_CANDIDATE_TYPES.has(localCandidateType) &&
      DIRECT_CANDIDATE_TYPES.has(remoteCandidateType);
    this.emit({
      type: "direct_path",
      direct,
      localCandidateType,
      remoteCandidateType,
    });
    if (!direct) {
      this.channel?.close?.();
    }
  }

  send(message) {
    if (!this.socket || this.socket.readyState !== 1) {
      throw new Error("signaling socket is not open");
    }
    this.socket.send(JSON.stringify(message));
  }

  emit(event) {
    this.onEvent(event);
  }
}
