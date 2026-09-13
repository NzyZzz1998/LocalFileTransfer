(() => {
  "use strict";

  const params = new URLSearchParams(location.search);
  const demoRole = params.get("demo");
  const isDemo = demoRole === "sender" || demoRole === "receiver";
  const MAX_MEMORY_BYTES = 256 * 1024 * 1024;
  const byId = (id) => document.getElementById(id);
  const screens = [byId("home-screen"), byId("sender-screen"), byId("receiver-screen")];
  const liveRegion = byId("live-region");

  let selectedFiles = [];
  let demoTimer = null;
  let progressTimer = null;
  let expiryTimer = null;
  let session = null;
  let sessionRole = null;
  let sessionScope = null;
  let relayEnabled = isDemo;
  let runtimeVersion = isDemo ? "0.2.0" : "unknown";
  let realModules = null;
  let senderEngine = null;
  let receiverEngine = null;
  let directChannel = null;
  let roomActive = false;
  const metricsByPrefix = new Map();
  const lastProgressPaint = new Map();
  const lastDiagnostics = new Map();
  let unloadCleanupStarted = false;
  const objectUrls = new Set();
  const cleanupJobs = new Set();
  const downloadJobs = new Set();
  const downloadTimers = new Map();
  const failedSinks = new Set();
  const shutdownPeers = new Set();
  const shutdownRequests = new Map();
  let shuttingDown = false;
  const TERMINAL_TRANSFER_STATES = new Set(["completed", "rejected", "cancelled", "failed"]);

  function announce(message) {
    liveRegion.textContent = message;
  }

  async function copyText(text, button, success = "已复制") {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(text);
      button.textContent = success;
      announce(success);
    } catch {
      const dialog = byId("copy-fallback-dialog");
      const field = byId("copy-fallback-text");
      field.value = text;
      if (!dialog.open) dialog.showModal();
      field.focus();
      field.select();
      announce("无法自动复制，已展示可手动复制的内容");
    }
  }

  const PHASE_INDEX = {
    idle: 0, connecting_signal: 0, waiting_peer: 1, joining_room: 1, waiting_approval: 1,
    finding_route: 2, verifying_channel: 3, ready: 4,
    relay_pending: 2, relay_connecting: 3, relay_ready: 4,
    transferring: 4, completed: 4, cancelled: 4,
  };
  const PHASE_LABEL = {
    idle: "尚未开始连接", connecting_signal: "正在连接配对服务", waiting_peer: "等待另一台电脑加入",
    waiting_approval: "等待发送方批准", finding_route: "正在建立局域网连接",
    joining_room: "正在查找本次传输",
    verifying_channel: "正在验证直连通道", ready: "直连已验证，等待确认文件",
    relay_pending: "等待双方确认本地中转", relay_connecting: "正在验证中转加密通道",
    relay_ready: "中转已建立，等待确认文件", transferring: "正在传输", completed: "文件已全部接收",
    cancelled: "本次传输已结束", direct_failed: "直连未成功", failed: "本次连接或传输失败",
  };
  const UI_ERROR_CODES = new Set([
    "RELAY_DECLINED", "RELAY_DISABLED", "RELAY_UNAVAILABLE", "RELAY_LIMIT", "RELAY_TIMEOUT",
    "RELAY_AUTH_FAILED", "RELAY_CLOSED", "RELAY_PROTOCOL_ERROR", "RELAY_HANDSHAKE_FAILED",
    "RELAY_CONNECT_FAILED", "TRANSFER_FAILED", "PEER_LEFT", "SIGNAL_OFFLINE", "PEER_REJECTED",
    "DIRECT_CONNECTION_FAILED", "DIRECT_CONNECTION_CLOSED", "DIRECT_CHANNEL_CLOSED", "DIRECT_CHANNEL_ERROR",
    "DIRECT_TIMEOUT", "DIRECT_UNSAFE_ROUTE", "DIRECT_STATS_UNAVAILABLE", "RTC_NEGOTIATION_FAILED",
  ]);

  function diagnosticFor(scope) {
    const peer = scope.peer?.getDiagnosticSnapshot();
    if (!peer) return lastDiagnostics.get(scope.role);
    const overlay = scope.diagnosticPhase;
    if (!overlay) return peer;
    const elapsed = overlay.terminal ? overlay.elapsedMs : Math.max(0, Math.round(performance.now() - overlay.at));
    return {
      ...peer, stage: overlay.stage, elapsedMs: elapsed,
      totalElapsedMs: overlay.totalElapsedMs + (overlay.terminal ? 0 : elapsed),
      failedStage: overlay.failedStage, errorCode: overlay.errorCode,
    };
  }

  function renderTimeline(role, snapshot) {
    if (!snapshot) return;
    lastDiagnostics.set(role, snapshot);
    const timeline = byId(`${role}-route-timeline`);
    const failed = snapshot.stage === "direct_failed" || snapshot.stage === "failed";
    const index = PHASE_INDEX[failed ? snapshot.failedStage : snapshot.stage] ?? 0;
    const ready = ["ready", "relay_ready", "transferring", "completed"].includes(snapshot.stage);
    timeline.hidden = snapshot.stage === "idle";
    for (const [position, item] of [...timeline.children].entries()) {
      item.className = position < index || (ready && position === index) ? "done"
        : position === index ? (failed ? "failed" : "active") : "";
      if (position === index && !failed && !ready) item.setAttribute("aria-current", "step");
      else item.removeAttribute("aria-current");
    }
    const relay = snapshot.stage.startsWith("relay_") || sessionScope?.role === role && sessionScope?.relayActive;
    timeline.querySelector('[data-step="route"]').textContent = relay ? "双方确认本地中转" : "建立局域网连接";
    timeline.querySelector('[data-step="verify"]').textContent = relay ? "验证中转加密通道" : "验证通道";
    byId(`${role}-diagnostic-tools`).hidden = false;
    byId(`${role}-phase-status`).textContent = `${PHASE_LABEL[snapshot.stage] ?? "连接状态未知"}${snapshot.errorCode ? ` · ${snapshot.errorCode}` : ""}`;
  }

  function recordUiPhase(scope, stage, code = null) {
    if (!isCurrentScope(scope)) return;
    const previous = diagnosticFor(scope);
    const terminal = ["failed", "completed", "cancelled"].includes(stage);
    scope.diagnosticPhase = {
      stage, at: performance.now(), terminal,
      elapsedMs: terminal ? previous?.elapsedMs ?? 0 : 0,
      totalElapsedMs: previous?.totalElapsedMs ?? 0,
      failedStage: stage === "failed" ? previous?.stage ?? "idle" : null,
      errorCode: code ? (UI_ERROR_CODES.has(code) ? code : "UNKNOWN") : null,
    };
    renderTimeline(scope.role, diagnosticFor(scope));
  }

  function browserFamily() {
    const ua = navigator.userAgent;
    return /Edg\//.test(ua) ? "Edge" : /Chrom(e|ium)\//.test(ua) ? "Chromium"
      : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "unknown";
  }

  function osFamily() {
    const ua = navigator.userAgent;
    return /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android"
      : /iPhone|iPad/.test(ua) ? "iOS" : /Macintosh|Mac OS X/.test(ua) ? "macOS"
      : /Linux/.test(ua) ? "Linux" : "unknown";
  }

  function copyDiagnostic(role, button) {
    const snapshot = sessionScope?.role === role ? diagnosticFor(sessionScope) : lastDiagnostics.get(role);
    if (!snapshot && !isDemo) return;
    const diagnostic = {
      version: runtimeVersion, os: osFamily(), browser: browserFamily(),
      ...(snapshot ?? { stage: "direct_failed", failedStage: "finding_route", elapsedMs: 20_000,
        totalElapsedMs: 20_000, signalingState: "online", iceState: "unknown", connectionState: "unknown",
        localCandidateType: "unknown", remoteCandidateType: "unknown", errorCode: "DIRECT_TIMEOUT" }),
    };
    void copyText(JSON.stringify(diagnostic, null, 2), button, "诊断已复制");
  }

  async function cleanupSink(sink) {
    try {
      await sink?.cleanup?.();
      failedSinks.delete(sink);
      return true;
    } catch {
      if (sink) failedSinks.add(sink);
      return false;
    }
  }

  function trackWork(promise, jobs = cleanupJobs) {
    jobs.add(promise);
    promise.then(() => jobs.delete(promise), () => jobs.delete(promise));
    return promise;
  }

  async function settleWork(jobs) {
    // A pending operation can register a final cleanup while it is settling.
    while (jobs.size) await Promise.allSettled([...jobs]);
  }

  function clearPageTimers() {
    if (expiryTimer) clearInterval(expiryTimer);
    if (progressTimer) clearInterval(progressTimer);
    if (demoTimer) clearTimeout(demoTimer);
    expiryTimer = progressTimer = demoTimer = null;
  }

  function shutdownStatus(message) {
    const status = byId("shutdown-status");
    status.textContent = message;
    status.hidden = !message;
    announce(message);
  }

  function showOnly(element, collection = screens) {
    for (const item of collection) item.hidden = item !== element;
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function showSenderStage(stage) {
    showOnly(stage, [byId("sender-prepare"), byId("sender-waiting")]);
  }

  function showReceiverStage(stage) {
    showOnly(stage, [
      byId("receiver-code-stage"),
      byId("receiver-searching"),
      byId("receiver-relay-consent"),
      byId("receiver-offer"),
      byId("receiver-progress"),
      byId("receiver-complete"),
    ]);
  }

  function formatBytes(bytes) {
    if (bytes === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / 1024 ** index;
    return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
  }

  function extensionOf(name) {
    const point = name.lastIndexOf(".");
    return point > 0 ? name.slice(point + 1).toUpperCase() : "FILE";
  }

  function createFileRow(file, removable = false, onRemove) {
    const item = document.createElement("li");
    item.className = "file-row";
    const name = document.createElement("span");
    name.className = "file-name";
    name.textContent = file.name;
    const kind = document.createElement("span");
    kind.className = "file-kind";
    kind.textContent = extensionOf(file.name);
    const size = document.createElement("span");
    size.className = "file-size";
    size.textContent = formatBytes(file.size);
    item.append(name, kind, size);
    if (removable) {
      const remove = document.createElement("button");
      remove.className = "remove-file";
      remove.type = "button";
      remove.textContent = "×";
      remove.setAttribute("aria-label", `移除 ${file.name}`);
      remove.addEventListener("click", onRemove);
      item.append(remove);
    }
    return item;
  }

  function renderSenderFiles() {
    const list = byId("sender-file-list");
    const summary = byId("sender-summary");
    const createButton = byId("create-room-button");
    list.replaceChildren();
    if (selectedFiles.length === 0) {
      list.classList.add("empty-list");
      const empty = document.createElement("li");
      empty.className = "empty-copy";
      empty.textContent = "尚未选择文件";
      list.append(empty);
      summary.textContent = "尚未选择文件";
      createButton.disabled = true;
      return;
    }
    list.classList.remove("empty-list");
    const total = selectedFiles.reduce((sum, file) => sum + file.size, 0);
    summary.textContent = `${selectedFiles.length} 个文件 · ${formatBytes(total)}`;
    createButton.disabled = sessionScope?.roomRequested === true;
    selectedFiles.forEach((file, index) => {
      list.append(
        createFileRow(file, true, () => {
          selectedFiles.splice(index, 1);
          renderSenderFiles();
        }),
      );
    });
  }

  function setFiles(fileList) {
    selectedFiles = Array.from(fileList);
    renderSenderFiles();
  }

  function setStation(state) {
    const labels = {
      connecting: "正在连接配对服务…",
      online: "配对服务在线",
      offline: "配对服务离线",
    };
    byId("station-status-text").textContent = labels[state] ?? labels.offline;
    const dot = document.querySelector(".signal-dot");
    dot.style.background = state === "online" ? "var(--green)" : "var(--orange)";
  }

  function showError(role, message) {
    const target =
      role === "sender"
        ? byId("sender-error")
        : byId("receiver-code-stage").hidden
          ? byId("receiver-error")
          : byId("join-error");
    target.textContent = message;
    target.hidden = false;
    announce(message);
  }

  function clearErrors() {
    byId("sender-error").hidden = true;
    byId("join-error").hidden = true;
    byId("receiver-error").hidden = true;
  }

  function errorMessage(event) {
    if (event.code === "ROOM_UNAVAILABLE") return "接收码无效、已过期或正在使用";
    if (event.code === "RATE_LIMITED") {
      const seconds = Math.max(1, Math.ceil((event.retryAfterMs ?? 1000) / 1000));
      return `尝试次数过多，请在 ${seconds} 秒后重试`;
    }
    if (event.code === "RTC_NEGOTIATION_FAILED") return "无法建立局域网直连";
    if (event.code === "DIRECT_TIMEOUT") return "20 秒内未能建立局域网直连";
    if (event.code === "DIRECT_UNSAFE_ROUTE") return "直连路线未通过验证";
    if (event.code === "DIRECT_STATS_UNAVAILABLE") return "无法验证这条直连路线";
    if (event.code?.startsWith("DIRECT_CONNECTION_") || event.code?.startsWith("DIRECT_CHANNEL_")) return "直连通道已中断";
    if (event.code === "RELAY_UNAVAILABLE" || event.code === "RELAY_DISABLED") return "本地中转目前不可用";
    if (event.code === "RELAY_LIMIT") return "本地中转已达到资源上限，请稍后重新连接";
    if (event.code === "RELAY_TIMEOUT") return "本地中转等待超时，请重新连接";
    if (event.code === "RELAY_AUTH_FAILED") return "中转数据校验失败，传输已停止，请重新连接";
    if (event.code === "INVALID_SERVER_MESSAGE") return "配对服务返回了无法识别的信息";
    return "这次传输的状态已经变化，请返回后重试";
  }

  async function loadRealModules() {
    if (!realModules) {
      const [peerModule, transferModule, storageModule, relayModule] = await Promise.all([
        import("./peer-session.js"),
        import("./transfer.js"),
        import("./storage.js"),
        import("./relay-transport.js"),
      ]);
      realModules = {
        PeerSession: peerModule.PeerSession,
        SenderEngine: transferModule.SenderEngine,
        ReceiverEngine: transferModule.ReceiverEngine,
        TransferMetrics: transferModule.TransferMetrics,
        createStorage: storageModule.createStorage,
        assessStorageCapability: storageModule.assessStorageCapability,
        cleanupTemporaryStorage: storageModule.cleanupTemporaryStorage,
        RelayTransport: relayModule.RelayTransport,
      };
    }
    return realModules;
  }

  function isCurrentScope(scope) {
    return scope !== null && sessionScope === scope && !scope.controller.signal.aborted;
  }

  function requireCurrentScope(scope) {
    if (!isCurrentScope(scope)) throw new DOMException("Session ended", "AbortError");
  }

  function ensureSession(role) {
    if (shuttingDown || shutdownPeers.size) return Promise.reject(new DOMException("Shutdown cleanup is pending", "AbortError"));
    if (sessionScope?.role === role && (
      !sessionScope.peer || [0, 1].includes(sessionScope.peer.socket?.readyState)
    )) return sessionScope.connection;
    // Invalidate synchronously, before module imports or browser-storage cleanup can yield.
    void releaseSession();
    const scope = {
      role,
      controller: new AbortController(),
      peer: null,
      connection: null,
      files: Object.freeze([]),
      relays: new Set(),
      relayOpening: false,
      relayActive: false,
      relayRequested: false,
      directFailed: false,
      directVerified: false,
      transferStarted: false,
      storageCheck: null,
    };
    sessionScope = scope;
    sessionRole = role;
    lastDiagnostics.delete(role);
    byId(role === "sender" ? "copy-diagnostic-button" : "receiver-copy-diagnostic-button").textContent = "复制诊断";
    scope.connection = (async () => {
      const modules = await loadRealModules();
      requireCurrentScope(scope);
      const peer = new modules.PeerSession({
        onEvent: (event) => {
          if (event.type === "service_shutdown") {
            void handleServiceShutdown(peer, event.requestId);
            return;
          }
          if (isCurrentScope(scope)) handleSessionEvent(event);
        },
      });
      scope.peer = peer;
      session = peer;
      await peer.connect();
      requireCurrentScope(scope);
      return peer;
    })().catch((error) => {
      if (!isCurrentScope(scope)) throw new DOMException("Session ended", "AbortError");
      void releaseSession();
      throw error;
    });
    return scope.connection;
  }

  function reportSessionError(role, error, message) {
    if (error.name !== "AbortError") showError(role, message);
  }

  async function createRoomForFiles(files) {
    const connection = ensureSession("sender");
    const scope = sessionScope;
    if (scope.roomRequested) return;
    scope.roomRequested = true;
    // A room owns its selection; later file-picker changes never alter its payload.
    scope.files = Object.freeze([...files]);
    const peer = await connection;
    requireCurrentScope(scope);
    try {
      peer.createRoom();
    } catch (error) {
      scope.roomRequested = false;
      throw error;
    }
  }

  function enterSender() {
    showOnly(byId("sender-screen"));
    showSenderStage(byId("sender-prepare"));
    byId("sender-title").textContent = "选择要发送的文件";
    clearErrors();
    announce("已进入发送文件");
    if (!isDemo) void ensureSession("sender").catch((error) => reportSessionError("sender", error, "暂时连接不上配对服务"));
  }

  function enterReceiver() {
    showOnly(byId("receiver-screen"));
    showReceiverStage(byId("receiver-code-stage"));
    byId("receiver-title").textContent = "输入发送方的接收码";
    clearErrors();
    byId("join-code").focus();
    announce("已进入接收文件");
    if (!isDemo) void ensureSession("receiver").catch((error) => reportSessionError("receiver", error, "暂时连接不上配对服务"));
  }

  function isEngineActive(engine) {
    return engine && !TERMINAL_TRANSFER_STATES.has(engine.state) && engine.state !== "idle";
  }

  function hasActiveWork() {
    return roomActive || isEngineActive(senderEngine) || isEngineActive(receiverEngine);
  }

  function hasUnsavedFiles() {
    return receiverEngine?.receivedFiles.some((entry) => entry.saved !== true) === true;
  }

  function preserveReceivedFiles() {
    const receiver = receiverEngine;
    const scope = sessionScope;
    if (scope.preservedFilesJob) return scope.preservedFilesJob;
    const partial = receiver.state !== "completed";
    // Install ownership before dispose emits a synchronous cancellation event.
    scope.preservedFilesJob = trackWork(Promise.resolve().then(async () => {
      if (receiver !== receiverEngine || scope !== sessionScope) return;
      const disposal = receiver.dispose();
      closeRelays(scope);
      scope.peer?.closeDirect();
      directChannel = null;
      roomActive = false;
      clearPageTimers();
      try { await disposal; } catch (error) { receiver.cleanupError = error; }
      if (receiver !== receiverEngine) return;
      if (partial) {
        renderReceivedFiles(receiver.receivedFiles);
        byId("receiver-title").textContent = "传输已停止，请保存已完整接收的文件";
        byId("receiver-complete").querySelector("h3").textContent = "部分文件已接收";
      }
    }));
    return scope.preservedFilesJob;
  }

  function closeRelays(scope) {
    for (const transport of scope?.relays ?? []) transport.close();
    scope?.relays.clear();
  }

  async function releaseSession({ keepSignaling = false } = {}) {
    clearPageTimers();
    const scope = sessionScope;
    const activeSession = session;
    const activeSender = senderEngine;
    const activeReceiver = receiverEngine;
    const receivedFiles = [...(activeReceiver?.receivedFiles ?? [])];
    const staleUrls = [...objectUrls];
    if (scope) {
      const diagnostic = diagnosticFor(scope);
      if (diagnostic) lastDiagnostics.set(scope.role, diagnostic);
    }

    sessionScope = null;
    session = null;
    sessionRole = null;
    senderEngine = null;
    receiverEngine = null;
    directChannel = null;
    roomActive = false;
    objectUrls.clear();
    metricsByPrefix.clear();
    lastProgressPaint.clear();

    let senderCancellation;
    let receiverCancellation;
    try {
      senderCancellation = activeSender?.dispose?.();
      receiverCancellation = activeReceiver?.dispose?.();
    } catch {
      // A broken transport must not prevent other resources from being released.
    } finally {
      scope?.controller.abort();
      closeRelays(scope);
      // Keep the control channel alive while cleanup or a user decision is
      // pending. leave() stops its heartbeat after success, never before ACK.
      activeSession?.closeDirect();
    }
    await trackWork((async () => {
      const results = await Promise.allSettled([senderCancellation, receiverCancellation, scope?.storageCheck?.task]);
      // Browser downloads still need their backing Blob during the handoff.
      await settleWork(downloadJobs);
      for (const url of staleUrls) URL.revokeObjectURL(url);
      const cleaned = await Promise.all(receivedFiles.map((entry) => cleanupSink(entry.sink)));
      if (activeReceiver) activeReceiver.receivedFiles.length = 0;
      const failed = cleaned.includes(false) || results.some((result, index) => result.status === "rejected"
        ? !(index === 2 && result.reason?.name === "AbortError")
        : result.value?.code === "STORAGE_CLEANUP_FAILED") || activeReceiver?.error?.code === "STORAGE_CLEANUP_FAILED" || Boolean(activeReceiver?.cleanupError);
      if (!keepSignaling && !shutdownRequests.has(activeSession)) {
        if ((failed || failedSinks.size) && !unloadCleanupStarted && activeSession?.socket?.readyState === 1) {
          // Keep the page reachable by a later shutdown retry; hiding it from
          // the coordinator would turn a failed cleanup into a false success.
          shutdownPeers.add(activeSession);
          shutdownStatus("有临时文件尚未清理完，请保留此页面并在本机点击关闭服务重试清理。");
        } else {
          shutdownPeers.delete(activeSession);
          activeSession?.leave();
        }
      }
    })());
  }

  async function cleanShutdownResources() {
    await settleWork(cleanupJobs);
    await settleWork(downloadJobs);
    for (const sink of [...failedSinks]) await cleanupSink(sink);
    await realModules?.cleanupTemporaryStorage(navigator);
    // The registry retry may have removed a sink whose first cleanup failed.
    for (const sink of [...failedSinks]) await cleanupSink(sink);
    if (failedSinks.size) throw new Error("temporary storage cleanup failed");
    for (const url of objectUrls) URL.revokeObjectURL(url);
    objectUrls.clear();
    selectedFiles = [];
    byId("send-file-input").value = "";
    // Remove download listeners/Blob closures only after the user saved or discarded them.
    byId("received-files").replaceChildren();
    byId("sender-file-list").replaceChildren();
    byId("receiver-file-list").replaceChildren();
    clearPageTimers();
  }

  async function handleServiceShutdown(peer, requestId) {
    if (typeof requestId !== "string" || !requestId || requestId.length > 128) return;
    const pending = shutdownRequests.get(peer);
    if (pending) {
      pending.requestId = requestId;
      return;
    }
    const request = { requestId };
    shutdownRequests.set(peer, request);
    shutdownPeers.add(peer);
    shuttingDown = true;
    clearPageTimers();
    let status = "cleanup_failed";
    try {
      if (hasUnsavedFiles()) {
        // Stop file transports, but keep control signaling until save/discard.
        await preserveReceivedFiles();
        shutdownStatus("有接收完成的文件尚未保存，已暂停关闭服务。请先保存文件，或返回首页并确认放弃，然后在本机重试关闭。");
        status = "unsaved";
      } else {
        shutdownStatus("正在结束连接并清理临时文件…");
        await releaseSession({ keepSignaling: true });
        await cleanShutdownResources();
        status = "ready";
        shutdownStatus("此页面的连接和临时资源已清理；服务是否退出以本机关闭结果为准。现在可以关闭此页面。");
      }
    } catch {
      shutdownStatus("临时资源未能清理完，服务暂未关闭。请保留此页面并在本机重试关闭。");
    } finally {
      try { peer.send({ type: "shutdown_ack", requestId: request.requestId, status }); } catch {
        shutdownStatus("关闭确认未送达，不能确认服务已退出；请在本机检查关闭结果。");
      }
      if (status === "ready") {
        shutdownPeers.delete(peer);
        peer.leave();
      }
      shutdownRequests.delete(peer);
      shuttingDown = false;
    }
  }

  async function resetHome() {
    if (demoTimer) clearTimeout(demoTimer);
    if (progressTimer) clearInterval(progressTimer);
    const cleanup = isDemo ? Promise.resolve() : releaseSession();
    selectedFiles = [];
    byId("send-file-input").value = "";
    renderSenderFiles();
    byId("join-code").value = "";
    byId("join-room-button").disabled = true;
    byId("sender-progress").hidden = true;
    byId("sender-connected").hidden = true;
    byId("sender-route-failed").hidden = true;
    byId("sender-route-timeline").hidden = true;
    byId("receiver-route-timeline").hidden = true;
    byId("sender-diagnostic-tools").hidden = true;
    byId("receiver-diagnostic-tools").hidden = true;
    lastDiagnostics.clear();
    byId("copy-fallback-dialog").close();
    byId("copy-fallback-text").value = "";
    byId("sender-relay-pending").hidden = true;
    byId("sender-route-fact").textContent = "尚未建立";
    byId("sender-encryption-fact").textContent = "尚未建立";
    byId("sender-relay-fact").textContent = "未启用";
    byId("receiver-route-fact").textContent = "尚未建立";
    byId("receiver-encryption-fact").textContent = "尚未建立";
    byId("receiver-connection-status").textContent = "等待连接";
    byId("create-room-button").textContent = "生成接收码";
    byId("copy-code-button").textContent = "复制接收码";
    clearErrors();
    showOnly(byId("home-screen"));
    announce("已返回首页");
    await cleanup;
  }

  async function requestBackHome() {
    if (
      !isDemo &&
      hasUnsavedFiles() &&
      !window.confirm("尚有接收完成的文件没有保存，返回后将无法恢复。确定返回首页吗？")
    ) {
      return;
    }
    if (
      !isDemo &&
      hasActiveWork() &&
      !window.confirm("这会结束当前房间或传输，并通知另一台电脑。确定返回首页吗？")
    ) {
      return;
    }
    await resetHome();
  }

  function createDemoRoom() {
    showSenderStage(byId("sender-waiting"));
    byId("sender-title").textContent = "等待接收方";
    byId("room-code").textContent = "583 204";
    byId("join-wait").hidden = false;
    byId("join-request").hidden = true;
    byId("sender-connected").hidden = true;
    announce("接收码已生成，等待另一台电脑");
    demoTimer = setTimeout(() => {
      byId("join-wait").hidden = true;
      byId("join-request").hidden = false;
      announce("一台电脑请求连接");
    }, 550);
  }

  function approveDemoPeer() {
    byId("join-request").hidden = true;
    byId("sender-connected").hidden = false;
    byId("sender-connected").querySelector("strong").textContent = "正在建立局域网直连…";
    byId("sender-connected").querySelector("small").textContent = "20 秒内未连接成功时会停止尝试并显示后续操作";
    byId("sender-route-timeline").hidden = false;
    byId("sender-route-fact").textContent = "正在寻找直连";
    byId("sender-encryption-fact").textContent = "尚未建立";
    announce("正在寻找局域网直连");
    demoTimer = setTimeout(() => {
      byId("sender-connected").hidden = true;
      byId("sender-route-timeline").hidden = true;
      byId("sender-route-failed").hidden = false;
      byId("sender-route-fact").textContent = "直连超时 · 未切换传输方式";
      announce("直连没有建立，可以重试或申请本地中转");
    }, 650);
  }

  function updateReceiveAcceptance(scope = sessionScope) {
    if (!isCurrentScope(scope)) return;
    byId("accept-files-button").disabled = !(
      receiverEngine?.state === "awaiting_acceptance" &&
      scope.storageCheck?.engine === receiverEngine &&
      scope.storageCheck.capability?.allowed === true &&
      (scope.directVerified || scope.relayActive)
    );
  }

  async function renderReceiverManifest(manifest, scope = sessionScope, engine = receiverEngine) {
    if (!isDemo && (!isCurrentScope(scope) || engine !== receiverEngine)) return;
    const check = isDemo ? null : { engine, controller: new AbortController(), capability: null };
    const abortCheck = () => check.controller.abort();
    if (check) {
      scope.storageCheck?.controller.abort();
      scope.storageCheck = check;
      scope.controller.signal.addEventListener("abort", abortCheck, { once: true });
    }
    const isCurrentCheck = () => isDemo || (
      isCurrentScope(scope) && scope.storageCheck === check && engine === receiverEngine &&
      engine.state === "awaiting_acceptance" && !check.controller.signal.aborted
    );
    const files = Array.isArray(manifest.files) ? manifest.files : [];
    const list = byId("receiver-file-list");
    list.replaceChildren(...files.map((file) => createFileRow(file)));
    const total = files.reduce((sum, file) => sum + file.size, 0);
    byId("receiver-summary").textContent = `${files.length} 个文件 · ${formatBytes(total)}`;
    byId("receiver-title").textContent = "核对这批文件";
    showReceiverStage(byId("receiver-offer"));
    const acceptButton = byId("accept-files-button");
    const contract = document.querySelector(".storage-contract");
    acceptButton.disabled = true;
    contract.textContent = "正在检查这台浏览器的接收能力…";
    try {
      const capability = isDemo
        ? { mode: "memory", allowed: true, limitBytes: MAX_MEMORY_BYTES }
        : await (check.task = trackWork(realModules.assessStorageCapability(files, navigator, MAX_MEMORY_BYTES, { signal: check.controller.signal })));
      if (!isCurrentCheck()) return;
      if (check) check.capability = capability;
      if (!capability.allowed) {
        const reason = capability.code === "FILE_TOO_LARGE"
          ? `文件「${capability.fileName ?? "未命名文件"}」超过 256 MiB；当前只能使用内存接收。`
          : capability.code === "BATCH_TOO_LARGE"
            ? "本批文件总量超过 256 MiB；当前只能使用内存接收。"
            : "浏览器临时存储检查或清理失败，请关闭本轮后重试。";
        const label = document.createElement("b");
        label.textContent = "无法接收这批文件";
        contract.replaceChildren(label, document.createTextNode(reason));
        showError("receiver", "存储预检未通过，尚未接收任何文件内容");
      } else {
        contract.innerHTML = capability.mode === "opfs"
          ? "<b>浏览器存储模式</b>已通过临时写入检查；浏览器未提供精确容量，不保证整批剩余空间。完成后仍需手动保存。"
          : "<b>内存接收模式</b>单个文件与本批总量上限均为 256 MiB；本批已通过容量预检。";
        if (isDemo) acceptButton.disabled = false;
        else updateReceiveAcceptance(scope);
      }
      announce("收到一份文件清单，请确认");
    } catch (error) {
      if (!isCurrentCheck()) return;
      contract.textContent = "无法确认浏览器存储是否可用，尚未允许接收文件。请结束本轮后重试。";
      showError("receiver", "存储预检失败，尚未接收任何文件内容");
    } finally {
      if (check) scope.controller.signal.removeEventListener("abort", abortCheck);
    }
  }

  function renderDemoOffer() {
    void renderReceiverManifest({ files: [{ name: "设计素材包.zip", size: 18.4 * 1024 * 1024 }] });
    byId("receiver-route-fact").textContent = "本地中转";
    byId("receiver-encryption-fact").textContent = "应用层加密";
    byId("receiver-connection-status").textContent = "本地中转";
  }

  function connectDemoReceiver() {
    showReceiverStage(byId("receiver-searching"));
    byId("receiver-title").textContent = "等待发送方允许连接";
    announce("正在查找传输");
    demoTimer = setTimeout(() => {
      showReceiverStage(byId("receiver-relay-consent"));
      byId("receiver-title").textContent = "确认是否使用本地中转";
      byId("receiver-route-fact").textContent = "等待你确认本地中转";
      announce("发送方请求改用本地中转");
    }, 600);
  }

  function renderReceivedFiles(entries) {
    showReceiverStage(byId("receiver-complete"));
    byId("receiver-title").textContent = "保存接收的文件";
    byId("receiver-complete").querySelector("h3").textContent = "接收完成";
    const container = byId("received-files");
    container.replaceChildren();
    for (const entry of entries) {
      const row = document.createElement("div");
      row.className = "received-file";
      const name = document.createElement("span");
      name.textContent = entry.file.name;
      const save = document.createElement("button");
      save.className = "primary-button";
      save.type = "button";
      save.textContent = "保存到电脑";
      save.setAttribute("aria-label", `保存 ${entry.file.name}`);
      save.addEventListener("click", () => {
        try {
          const url = URL.createObjectURL(entry.result);
          objectUrls.add(url);
          const link = document.createElement("a");
          link.href = url;
          link.download = entry.file.name;
          document.body.append(link);
          link.click();
          link.remove();
          entry.saved = true;
          save.textContent = "已交给浏览器下载";
          announce(`${entry.file.name} 已交给浏览器下载`);
          trackWork(new Promise((resolve) => {
            const finish = async () => {
              downloadTimers.delete(timer);
              URL.revokeObjectURL(url);
              objectUrls.delete(url);
              await cleanupSink(entry.sink);
              resolve();
            };
            const timer = setTimeout(finish, 5_000);
            downloadTimers.set(timer, finish);
          }), downloadJobs);
        } catch {
          save.textContent = "保存失败 · 重试";
          announce("浏览器未能开始下载，文件仍暂存在当前页面，可再次尝试");
        }
      });
      row.append(name, save);
      container.append(row);
    }
    announce("接收完成，请保存文件");
  }

  function updateProgress(prefix, progress) {
    let metrics = metricsByPrefix.get(prefix);
    if (!metrics || progress.overallBytes === 0) {
      metrics = new realModules.TransferMetrics();
      metricsByPrefix.set(prefix, metrics);
    }
    const measurement = metrics.update(progress.overallBytes, progress.totalBytes);
    const now = performance.now();
    if (progress.overallBytes < progress.totalBytes && now - (lastProgressPaint.get(prefix) ?? -Infinity) < 250) return;
    lastProgressPaint.set(prefix, now);
    const percent = progress.totalBytes === 0 ? 100 : Math.round((progress.overallBytes / progress.totalBytes) * 100);
    const output = byId(prefix === "sender" ? "sender-progress-percent" : "progress-percent");
    const fill = byId(prefix === "sender" ? "sender-waterline-fill" : "waterline-fill");
    const file = byId(prefix === "sender" ? "sender-progress-file" : "progress-file");
    const bytes = byId(prefix === "sender" ? "sender-progress-bytes" : "progress-bytes");
    output.textContent = `${percent}%`;
    fill.style.width = `${percent}%`;
    if (fill.nextElementSibling) fill.nextElementSibling.style.left = `${percent}%`;
    fill.parentElement.setAttribute("aria-valuenow", String(percent));
    file.textContent = progress.file.name;
    bytes.textContent = `${formatBytes(progress.overallBytes)} / ${formatBytes(progress.totalBytes)}`;
    const speed = byId(prefix === "sender" ? "sender-current-speed" : "receiver-current-speed");
    const averageEta = byId(prefix === "sender" ? "sender-average-eta" : "receiver-average-eta");
    const elapsed = byId(prefix === "sender" ? "sender-elapsed" : "receiver-elapsed");
    speed.textContent = measurement.currentBytesPerSecond > 0
      ? `${formatBytes(measurement.currentBytesPerSecond)}/s`
      : "计算中";
    averageEta.textContent = measurement.averageBytesPerSecond > 0
      ? `${formatBytes(measurement.averageBytesPerSecond)}/s / ${measurement.etaMs === null ? "计算中" : `${Math.ceil(measurement.etaMs / 1_000)} 秒`}`
      : "— / —";
    elapsed.textContent = `${Math.floor(measurement.elapsedMs / 1_000)} 秒`;
  }

  function setupReceiver(channel, scope = sessionScope) {
    if (!isCurrentScope(scope) || receiverEngine) return;
    const engine = new realModules.ReceiverEngine(channel, {
      createSink: async (file) => {
        requireCurrentScope(scope);
        if (engine !== receiverEngine || !scope.storageMode) throw new Error("Storage contract is not selected");
        const sink = await realModules.createStorage({ ...file, mode: scope.storageMode, maxMemoryBytes: MAX_MEMORY_BYTES, navigator });
        if (!isCurrentScope(scope) || engine !== receiverEngine || engine.state !== "receiving") {
          try {
            await sink.abort?.();
          } finally {
            await cleanupSink(sink);
          }
          throw new DOMException("Transfer ended", "AbortError");
        }
        return sink;
      },
      onManifest: (manifest) => void renderReceiverManifest(manifest, scope, engine),
      onProgress: (progress) => {
        if (isCurrentScope(scope) && engine === receiverEngine) updateProgress("receiver", progress);
      },
      onState: (state) => {
        if (!isCurrentScope(scope) || engine !== receiverEngine) return;
        if (state === "receiving") {
          scope.transferStarted = true;
          recordUiPhase(scope, "transferring");
          showReceiverStage(byId("receiver-progress"));
          byId("receiver-title").textContent = "正在传输";
        }
        if (state === "completed") {
          roomActive = false;
          recordUiPhase(scope, "completed");
          renderReceivedFiles(engine.receivedFiles);
        }
        if (state === "rejected") roomActive = false;
        if (state === "cancelled") {
          roomActive = false;
          recordUiPhase(scope, "cancelled");
          showError("receiver", "发送方取消了这次传输");
          closeRelays(scope);
          if (hasUnsavedFiles()) void preserveReceivedFiles();
        }
        if (state === "failed") {
          roomActive = false;
          recordUiPhase(scope, "failed", scope.relayFailure?.code ?? "TRANSFER_FAILED");
          showError("receiver", scope.relayFailure ? errorMessage(scope.relayFailure) : "传输数据异常，本次传输已停止");
          closeRelays(scope);
          if (hasUnsavedFiles()) void preserveReceivedFiles();
        }
      },
    });
    receiverEngine = engine;
  }

  function setupSender(channel, scope = sessionScope) {
    if (!isCurrentScope(scope) || senderEngine) return;
    const engine = new realModules.SenderEngine(channel, {
      onProgress: (progress) => {
        if (isCurrentScope(scope) && engine === senderEngine) updateProgress("sender", progress);
      },
      onState: (state) => {
        if (!isCurrentScope(scope) || engine !== senderEngine) return;
        if (state === "awaiting_acceptance") {
          byId("sender-connected").hidden = false;
          byId("sender-connected").querySelector("strong").textContent = "等待对方确认文件";
        }
        if (state === "transferring") {
          scope.transferStarted = true;
          recordUiPhase(scope, "transferring");
          byId("sender-connected").hidden = true;
          byId("sender-progress").hidden = false;
          byId("sender-title").textContent = "正在传输";
        }
        if (state === "completed") {
          roomActive = false;
          recordUiPhase(scope, "completed");
          byId("sender-progress").hidden = false;
          byId("sender-progress-percent").textContent = "100%";
          byId("sender-title").textContent = "接收方已接收全部文件";
          announce("接收方已接收全部文件，是否保存到电脑由接收方确认");
        }
        if (state === "rejected") {
          roomActive = false;
          recordUiPhase(scope, "cancelled", "PEER_REJECTED");
          showError("sender", "对方没有接收这批文件");
        }
        if (state === "cancelled") {
          roomActive = false;
          recordUiPhase(scope, "cancelled");
          showError("sender", "接收方取消了这次传输");
        }
        if (state === "failed") {
          roomActive = false;
          recordUiPhase(scope, "failed", scope.relayFailure?.code ?? "TRANSFER_FAILED");
          showError("sender", scope.relayFailure ? errorMessage(scope.relayFailure) : "文件传输失败，请重新开始");
        }
        if (TERMINAL_TRANSFER_STATES.has(state)) {
          // Success closes from the sender only, after the receiver's final receipt.
          closeRelays(scope);
        }
      },
    });
    senderEngine = engine;
    engine.send(scope.files).catch(() => {
      if (isCurrentScope(scope) && engine === senderEngine && engine.state !== "failed") showError("sender", "文件传输失败，请重新开始");
    });
  }

  function updateExpiry(expiresAt) {
    if (expiryTimer) clearInterval(expiryTimer);
    const render = () => {
      const remaining = Math.max(0, expiresAt - Date.now());
      const totalSeconds = Math.ceil(remaining / 1000);
      const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
      const seconds = String(totalSeconds % 60).padStart(2, "0");
      byId("room-expiry").textContent = remaining > 0 ? `${minutes}:${seconds} 后失效` : "接收码已过期";
    };
    render();
    expiryTimer = setInterval(render, 1_000);
  }

  function stopAfterConnectionFailure(message) {
    if (!hasActiveWork()) return;
    const failedRole = sessionRole;
    roomActive = false;
    byId("use-relay-button").disabled = true;
    byId("sender-connected").hidden = true;
    byId("sender-relay-pending").hidden = true;
    if (failedRole === "receiver" && hasUnsavedFiles()) {
      // RTC/relay close can arrive before the service's shutdown message.
      // Protect finalized files in either event order, not just in the button path.
      void preserveReceivedFiles();
      showError("receiver", `${message}；已收完的文件仍可保存，请先保存或明确放弃。`);
      return;
    }
    if (failedRole === "receiver") {
      showReceiverStage(byId("receiver-code-stage"));
      byId("receiver-title").textContent = "这次连接已经结束";
    }
    showError(failedRole, message);
    void releaseSession();
  }

  function canChangeRoute(scope) {
    return isCurrentScope(scope) && !scope.transferStarted && scope.peer?.socket?.readyState === 1 &&
      [senderEngine, receiverEngine].every((engine) => !engine || ["idle", "awaiting_acceptance"].includes(engine.state));
  }

  function retirePendingDirect(scope) {
    scope.storageCheck?.controller.abort();
    scope.storageCheck = null;
    scope.storageMode = null;
    scope.directVerified = false;
    const previousEngines = [senderEngine, receiverEngine];
    senderEngine = null;
    receiverEngine = null;
    directChannel = null;
    byId("accept-files-button").disabled = true;
    for (const engine of previousEngines) {
      // No file acceptance has occurred. Retire locally without sending a user
      // cancellation that would incorrectly end the surviving signaling room.
      engine?.removeMessageListener?.();
      engine?.removeCloseListener?.();
      const ending = engine?.finishCancelled?.();
      ending?.catch?.(() => {});
    }
  }

  function handleDirectFailure(event) {
    const scope = sessionScope;
    if (!isCurrentScope(scope) || scope.relayRequested || scope.relayOpening || scope.relayActive || scope.directFailed) return;
    if (["completed", "cancelled"].includes(scope.diagnosticPhase?.stage)) return;
    if (!canChangeRoute(scope)) {
      if (scope.diagnosticPhase?.stage !== "failed") recordUiPhase(scope, "failed", event.code);
      stopAfterConnectionFailure("直连已中断，本次传输已结束；不会在传输中切换为本地中转");
      return;
    }
    scope.directFailed = true;
    scope.directFailure = { code: event.code, elapsedMs: event.elapsedMs ?? null };
    retirePendingDirect(scope);
    byId("use-relay-button").disabled = !relayEnabled || !canChangeRoute(scope);
    const message = errorMessage(event);
    if (scope.role === "sender") {
      byId("sender-connected").hidden = true;
      byId("sender-route-failed").hidden = false;
      byId("sender-route-failed").querySelector(".decision-code").textContent =
        `${event.code}${Number.isFinite(event.elapsedMs) ? ` · ${(event.elapsedMs / 1_000).toFixed(1)}s` : ""}`;
      byId("sender-route-fact").textContent = `${message} · 未切换传输方式`;
    } else {
      showReceiverStage(byId("receiver-searching"));
      byId("receiver-title").textContent = "直连未成功，等待发送方选择";
      byId("receiver-searching").querySelector("h3").textContent = message;
      byId("receiver-searching").querySelector("p:last-child").textContent = "房间仍保持连接，等待发送方重试或申请本地中转";
      byId("receiver-route-fact").textContent = "直连未成功 · 未切换传输方式";
    }
    announce(`${message}；尚未发送文件内容，可以重试或申请本地中转`);
  }

  function handleSessionEvent(event) {
    if (event.type === "phase") {
      if (sessionScope.diagnosticPhase) return;
      const { type, ...snapshot } = event;
      renderTimeline(sessionScope.role, snapshot);
      return;
    }
    if ((sessionScope.relayRequested || sessionScope.relayOpening || sessionScope.relayActive || sessionScope.directFailed) && (
      event.type === "direct_connection" ||
      (event.type === "error" && ["DIRECT_TIMEOUT", "RTC_NEGOTIATION_FAILED"].includes(event.code))
    )) return;
    if (event.type === "signaling") {
      setStation(event.state);
      if (event.state === "offline" && sessionScope.diagnosticPhase && !["completed", "cancelled", "failed"].includes(sessionScope.diagnosticPhase.stage)) {
        recordUiPhase(sessionScope, "failed", "SIGNAL_OFFLINE");
      }
      if (event.state === "offline" && roomActive && !directChannel) {
        stopAfterConnectionFailure("配对服务连接已断开，请重新开始");
      }
      return;
    }
    if (event.type === "room_created") {
      roomActive = true;
      showSenderStage(byId("sender-waiting"));
      byId("sender-title").textContent = "等待接收方";
      byId("room-code").textContent = `${event.code.slice(0, 3)} ${event.code.slice(3)}`;
      byId("join-wait").hidden = false;
      byId("join-request").hidden = true;
      byId("sender-connected").hidden = true;
      byId("sender-progress").hidden = true;
      updateExpiry(event.expiresAt);
      announce("接收码已生成，等待另一台电脑");
      return;
    }
    if (event.type === "join_waiting") {
      roomActive = true;
      showReceiverStage(byId("receiver-searching"));
      byId("receiver-title").textContent = "等待发送方允许连接";
      announce("正在等待发送方允许连接");
      return;
    }
    if (event.type === "join_requested") {
      byId("join-wait").hidden = true;
      byId("join-request").hidden = false;
      announce("一台浏览器请求接收");
      return;
    }
    if (event.type === "join_rejected") {
      showReceiverStage(byId("receiver-code-stage"));
      showError("receiver", "发送方拒绝了这次连接");
      return;
    }
    if (event.type === "peer_joined") {
      roomActive = true;
      if (event.role === "sender") {
        byId("join-request").hidden = true;
        byId("sender-connected").hidden = false;
        byId("sender-connected").querySelector("strong").textContent = "正在建立局域网直连…";
        byId("sender-connected").querySelector("small").textContent = "正在协商加密通道";
      } else {
        showReceiverStage(byId("receiver-searching"));
        byId("receiver-title").textContent = "正在建立局域网直连";
        byId("receiver-searching").querySelector("h3").textContent = "发送方已允许，正在直连…";
      }
      return;
    }
    if (event.type === "direct_connection" && event.state === "slow") {
      if (sessionRole === "sender") {
        byId("sender-route-timeline").hidden = false;
        byId("sender-connected").querySelector("small").textContent = "连接比平时慢，最多等待 20 秒";
      } else {
        byId("receiver-searching").querySelector("p:last-child").textContent = "连接比平时慢，最多等待 20 秒";
      }
      byId(`${sessionRole}-phase-status`).textContent = "仍在尝试连接，最多等待 20 秒";
      announce("仍在尝试建立局域网连接");
      return;
    }
    if (event.type === "direct_failed") {
      handleDirectFailure(event);
      return;
    }
    if (event.type === "data_channel" && event.state === "open") {
      if (sessionScope.directFailed || sessionScope.relayRequested || sessionScope.relayOpening || sessionScope.relayActive) {
        event.channel.close();
        return;
      }
      directChannel = event.channel;
      if (sessionRole === "receiver") setupReceiver(event.channel);
      return;
    }
    if (event.type === "data_channel" && event.state === "closed") {
      handleDirectFailure({ code: "DIRECT_CHANNEL_CLOSED" });
      return;
    }
    if (event.type === "peer_connection") {
      if (sessionScope.relayRequested || sessionScope.relayOpening || sessionScope.relayActive) return;
      if (event.state === "failed" || event.state === "closed") {
        handleDirectFailure({ code: "DIRECT_CONNECTION_FAILED" });
      } else if (event.state === "disconnected" && hasActiveWork()) {
        announce("局域网连接暂时中断，正在尝试恢复");
      }
      return;
    }
    if (event.type === "relay_requested") {
      if (!canChangeRoute(sessionScope)) {
        session?.rejectRelay();
        return;
      }
      retirePendingDirect(sessionScope);
      sessionScope.relayRequested = true;
      session?.closeDirect();
      recordUiPhase(sessionScope, "relay_pending");
      byId("approve-relay-button").disabled = !relayEnabled;
      showReceiverStage(byId("receiver-relay-consent"));
      byId("receiver-title").textContent = "确认是否使用本地中转";
      byId("receiver-route-fact").textContent = "等待你确认本地中转";
      announce("发送方请求改用本地中转");
      return;
    }
    if (event.type === "relay_declined") {
      sessionScope.relayRequested = false;
      recordUiPhase(sessionScope, "failed", "RELAY_DECLINED");
      byId("sender-relay-pending").hidden = true;
      byId("sender-route-failed").hidden = false;
      showError("sender", "接收方拒绝了本地中转，本次仍未发送文件内容");
      return;
    }
    if (event.type === "relay_ready") {
      void openRelayTransport(event);
      return;
    }
    if (event.type === "direct_path") {
      if (sessionScope.directFailed || sessionScope.relayRequested || sessionScope.relayOpening || sessionScope.relayActive) return;
      // Failure is retired by the following direct_failed event, before RTC closes.
      if (!event.direct) return;
      sessionScope.directVerified = true;
      const routeFact = byId(sessionRole === "sender" ? "sender-route-fact" : "receiver-route-fact");
      const encryptionFact = byId(sessionRole === "sender" ? "sender-encryption-fact" : "receiver-encryption-fact");
      routeFact.textContent = "局域网直连";
      encryptionFact.textContent = "已建立";
      if (sessionRole === "sender" && directChannel) setupSender(directChannel);
      if (sessionRole === "receiver") updateReceiveAcceptance(sessionScope);
      if (sessionRole === "receiver") byId("receiver-connection-status").textContent = "局域网直连";
      return;
    }
    if (event.type === "room_expired") {
      stopAfterConnectionFailure("接收码已过期，请重新开始");
      return;
    }
    if (event.type === "peer_left" || event.type === "room_closed") {
      if (sessionScope.diagnosticPhase && !["completed", "cancelled", "failed"].includes(sessionScope.diagnosticPhase.stage)) recordUiPhase(sessionScope, "failed", "PEER_LEFT");
      stopAfterConnectionFailure("连接已断开，本次传输无法继续");
      return;
    }
    if (event.type === "error") {
      const message = errorMessage(event);
      if (["DIRECT_TIMEOUT", "RTC_NEGOTIATION_FAILED"].includes(event.code)) {
        handleDirectFailure(event);
      } else {
        if (event.code?.startsWith("RELAY_")) {
          recordUiPhase(sessionScope, "failed", event.code);
          if (sessionScope.relayOpening || sessionScope.relayActive) {
            sessionScope.relayFailure = event;
            stopAfterConnectionFailure(message);
            return;
          }
          if (sessionRole === "sender") {
            sessionScope.relayRequested = false;
            byId("sender-relay-pending").hidden = true;
            byId("sender-route-failed").hidden = false;
          }
        }
        if (
          sessionRole === "receiver" &&
          (event.code === "ROOM_UNAVAILABLE" || event.code === "RATE_LIMITED")
        ) {
          roomActive = false;
          showReceiverStage(byId("receiver-code-stage"));
        }
        showError(sessionRole, message);
      }
    }
  }

  async function openRelayTransport(event) {
    const scope = sessionScope;
    if (!isCurrentScope(scope) || !relayEnabled || scope.relayOpening || scope.relayActive) return;
    if (senderEngine || receiverEngine) {
      showError(scope.role, "当前传输已选择路线，请结束后再申请中转");
      return;
    }
    scope.peer.closeDirect();
    scope.relayOpening = true;
    recordUiPhase(scope, "relay_connecting");
    let transport;
    try {
      const modules = await loadRealModules();
      requireCurrentScope(scope);
      transport = new modules.RelayTransport({ token: event.token });
      scope.relays.add(transport);
      transport.addEventListener("close", (closeEvent) => {
        scope.relays.delete(transport);
        scope.relayFailure = closeEvent;
      });
      transport.addEventListener("error", (errorEvent) => { scope.relayFailure = errorEvent; });
      await transport.connect({ signal: scope.controller.signal });
      requireCurrentScope(scope);
      if (transport.readyState !== "open") throw new Error("relay closed during setup");
      scope.relayOpening = false;
      scope.relayActive = true;
      directChannel = transport;
      recordUiPhase(scope, "relay_ready");
      if (scope.role === "sender") {
        byId("sender-relay-pending").hidden = true;
        byId("sender-route-fact").textContent = "本地中转";
        byId("sender-encryption-fact").textContent = "应用层加密";
        byId("sender-relay-fact").textContent = "双方已确认";
        setupSender(transport, scope);
      } else {
        byId("receiver-route-fact").textContent = "本地中转";
        byId("receiver-encryption-fact").textContent = "应用层加密";
        byId("receiver-connection-status").textContent = "本地中转";
        setupReceiver(transport, scope);
      }
      announce("本地中转加密通道已建立");
    } catch (error) {
      transport?.close();
      scope.relays.delete(transport);
      if (!isCurrentScope(scope)) return;
      scope.relayOpening = false;
      recordUiPhase(scope, "failed", error.code ?? "RELAY_UNAVAILABLE");
      byId("sender-relay-pending").hidden = true;
      stopAfterConnectionFailure(error.code ? errorMessage(error) : "本地中转加密通道建立失败，请重新连接");
    }
  }

  async function cancelCurrentTransfer() {
    if (isDemo) {
      await resetHome();
      return;
    }
    await resetHome();
  }

  function completeDemoReceive() {
    if (progressTimer) clearInterval(progressTimer);
    showReceiverStage(byId("receiver-complete"));
    byId("receiver-title").textContent = "保存接收的文件";
    const files = byId("received-files");
    files.replaceChildren();
    const row = document.createElement("div");
    row.className = "received-file";
    const name = document.createElement("span");
    name.textContent = "设计素材包.zip";
    const save = document.createElement("button");
    save.className = "primary-button";
    save.type = "button";
    save.textContent = "演示保存（不下载）";
    save.setAttribute("aria-label", "演示保存 设计素材包.zip（不下载）");
    save.addEventListener("click", () => announce("演示模式不会写入文件"));
    row.append(name, save);
    files.append(row);
    announce("接收完成，请保存文件");
  }

  function startDemoReceive() {
    showReceiverStage(byId("receiver-progress"));
    byId("receiver-title").textContent = "正在传输";
    let progress = 0;
    progressTimer = setInterval(() => {
      progress = Math.min(100, progress + 20);
      byId("progress-percent").textContent = `${progress}%`;
      byId("progress-bytes").textContent = `${formatBytes((18.4 * 1024 * 1024 * progress) / 100)} / 18.4 MB`;
      byId("receiver-current-speed").textContent = progress < 20 ? "计算中" : "31.6 MB/s";
      byId("receiver-average-eta").textContent = progress < 20 ? "— / —" : `28.9 MB/s / ${Math.max(0, Math.ceil((100 - progress) / 40))} 秒`;
      byId("waterline-fill").style.width = `${progress}%`;
      byId("waterline-fill").nextElementSibling.style.left = `${progress}%`;
      byId("waterline-fill").parentElement.setAttribute("aria-valuenow", String(progress));
      if (progress === 100) setTimeout(completeDemoReceive, 180);
    }, 190);
  }

  function bestEffortPageExitCleanup() {
    if (isDemo || unloadCleanupStarted) return;
    unloadCleanupStarted = true;
    // Page destruction cancels its timers. Start these removals now instead of
    // waiting forever for a download-grace callback on a destroyed document.
    for (const [timer, finish] of downloadTimers) {
      clearTimeout(timer);
      void finish();
    }
    void releaseSession();
    for (const peer of shutdownPeers) peer.leave();
    shutdownPeers.clear();
  }

  byId("choose-sender").addEventListener("click", enterSender);
  byId("choose-receiver").addEventListener("click", enterReceiver);
  document.querySelectorAll('[data-action="back-home"]').forEach((button) =>
    button.addEventListener("click", () => void requestBackHome()),
  );
  document.querySelectorAll('[data-action="cancel-session"]').forEach((button) =>
    button.addEventListener("click", () => void cancelCurrentTransfer()),
  );

  const fileInput = byId("send-file-input");
  const dropzone = byId("send-dropzone");
  fileInput.addEventListener("change", () => setFiles(fileInput.files));
  for (const eventName of ["dragenter", "dragover"]) {
    dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropzone.classList.add("is-dragging");
    });
  }
  for (const eventName of ["dragleave", "drop"]) {
    dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropzone.classList.remove("is-dragging");
    });
  }
  dropzone.addEventListener("drop", (event) => {
    if (event.dataTransfer?.files) setFiles(event.dataTransfer.files);
  });

  byId("create-room-button").addEventListener("click", async () => {
    if (isDemo) {
      createDemoRoom();
      return;
    }
    const button = byId("create-room-button");
    button.disabled = true;
    button.textContent = "正在生成接收码…";
    clearErrors();
    const creation = createRoomForFiles([...selectedFiles]);
    const scope = sessionScope;
    try {
      await creation;
    } catch (error) {
      if (error.name !== "AbortError") {
        showError("sender", "暂时无法生成接收码，请稍后重试");
        button.disabled = false;
        button.textContent = "生成接收码";
      }
    } finally {
      if (isCurrentScope(scope)) button.textContent = "生成接收码";
    }
  });

  byId("copy-code-button").addEventListener("click", async () => {
    const button = byId("copy-code-button");
    const code = byId("room-code").textContent.replace(/\s/g, "");
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(code);
      button.textContent = "已复制";
      announce("接收码已复制");
    } catch {
      announce("无法自动复制，请选中接收码手动复制");
    }
  });

  byId("use-relay-button").addEventListener("click", () => {
    if (!relayEnabled) return;
    if (!isDemo) {
      if (!canChangeRoute(sessionScope) || !sessionScope.directFailed) return;
      retirePendingDirect(sessionScope);
      sessionScope.relayRequested = true;
      session.closeDirect();
      recordUiPhase(sessionScope, "relay_pending");
    }
    byId("sender-route-failed").hidden = true;
    byId("sender-relay-pending").hidden = false;
    byId("sender-route-fact").textContent = "本地中转 · 等待确认";
    byId("sender-relay-fact").textContent = "接收方确认中";
    announce("已申请本地中转，等待接收方同意");
    if (!isDemo) session?.requestRelay();
  });

  byId("retry-direct-button").addEventListener("click", () => {
    byId("sender-route-failed").hidden = true;
    if (isDemo) {
      byId("sender-connected").hidden = false;
      byId("sender-route-timeline").hidden = false;
      announce("已重新开始寻找局域网直连");
      return;
    }
    const retryFiles = [...(sessionScope?.files ?? selectedFiles)];
    selectedFiles = retryFiles;
    renderSenderFiles();
    void releaseSession();
    void createRoomForFiles(retryFiles)
      .catch((error) => reportSessionError("sender", error, "重试失败，暂时连接不上配对服务"));
  });

  byId("copy-diagnostic-button").addEventListener("click", (event) => copyDiagnostic("sender", event.currentTarget));
  byId("receiver-copy-diagnostic-button").addEventListener("click", (event) => copyDiagnostic("receiver", event.currentTarget));

  byId("approve-peer-button").addEventListener("click", () => {
    if (isDemo) approveDemoPeer();
    else session?.approveJoin();
  });
  byId("reject-peer-button").addEventListener("click", () => {
    if (!isDemo) session?.rejectJoin();
    byId("join-request").hidden = true;
    byId("join-wait").hidden = false;
    announce("已拒绝连接请求");
  });

  const codeInput = byId("join-code");
  codeInput.addEventListener("input", () => {
    const digits = codeInput.value.replace(/\D/g, "").slice(0, 6);
    codeInput.value = digits.length > 3 ? `${digits.slice(0, 3)} ${digits.slice(3)}` : digits;
    byId("join-room-button").disabled = digits.length !== 6;
    byId("join-error").hidden = true;
    byId("receiver-error").hidden = true;
  });

  byId("join-room-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (isDemo) {
      connectDemoReceiver();
      return;
    }
    const code = codeInput.value.replace(/\D/g, "");
    showReceiverStage(byId("receiver-searching"));
    byId("receiver-title").textContent = "正在查找本次传输";
    const connection = ensureSession("receiver");
    const scope = sessionScope;
    try {
      const peer = await connection;
      requireCurrentScope(scope);
      peer.joinRoom(code);
    } catch (error) {
      if (error.name === "AbortError") return;
      showReceiverStage(byId("receiver-code-stage"));
      showError("receiver", "暂时连接不上配对服务");
    }
  });

  byId("approve-relay-button").addEventListener("click", () => {
    if (!relayEnabled) return;
    if (isDemo) renderDemoOffer();
    else {
      byId("approve-relay-button").disabled = true;
      showReceiverStage(byId("receiver-searching"));
      byId("receiver-title").textContent = "正在建立本地中转";
      byId("receiver-searching").querySelector("h3").textContent = "正在协商中转加密通道…";
      byId("receiver-searching").querySelector("p:last-child").textContent = "连接建立后仍需确认文件清单，才会发送文件内容";
      session?.approveRelay();
    }
  });
  byId("reject-relay-button").addEventListener("click", () => {
    if (isDemo) void resetHome();
    else {
      session?.rejectRelay();
      sessionScope.relayRequested = false;
      sessionScope.directFailed = true;
      recordUiPhase(sessionScope, "failed", "RELAY_DECLINED");
      showReceiverStage(byId("receiver-searching"));
      byId("receiver-title").textContent = "已拒绝本次中转";
      byId("receiver-searching").querySelector("h3").textContent = "房间仍保持连接";
      byId("receiver-searching").querySelector("p:last-child").textContent = "尚未发送文件内容，等待发送方重试或再次申请中转；也可以返回首页结束本轮";
      byId("receiver-route-fact").textContent = "中转已拒绝 · 未切换传输方式";
      announce("已拒绝本次中转，房间仍保持连接");
    }
  });

  byId("accept-files-button").addEventListener("click", () => {
    if (isDemo) startDemoReceive();
    else if (receiverEngine?.state === "awaiting_acceptance") {
      updateReceiveAcceptance();
      if (byId("accept-files-button").disabled) return;
      sessionScope.storageMode = sessionScope.storageCheck.capability.mode;
      receiverEngine.accept();
    }
    else showError("receiver", "这批文件已经不能接收，请重新连接");
  });
  byId("reject-files-button").addEventListener("click", () => {
    if (isDemo) void resetHome();
    else if (receiverEngine?.state === "awaiting_acceptance") {
      const scope = sessionScope;
      receiverEngine.reject();
      setTimeout(() => {
        if (isCurrentScope(scope)) void resetHome();
      }, 100);
    } else showError("receiver", "这批文件的状态已经变化，请重新连接");
  });
  byId("cancel-transfer-button").addEventListener("click", () => void cancelCurrentTransfer());
  addEventListener("pagehide", bestEffortPageExitCleanup);
  addEventListener("beforeunload", bestEffortPageExitCleanup);

  function renderRelayAvailability() {
    byId("use-relay-button").hidden = !relayEnabled;
    byId("use-relay-button").disabled = !relayEnabled;
    byId("approve-relay-button").disabled = !relayEnabled;
    byId("relay-disabled-notice").hidden = relayEnabled;
    byId("home-relay-policy").textContent = relayEnabled
      ? "默认浏览器直连；直连失败时，只有双方确认才会经过运行渡口服务的电脑内存中转。"
      : "本地中转已关闭或不可用；当前仅使用浏览器直连。";
  }

  async function initializeLanAccess() {
    const output = byId("lan-url");
    const button = byId("copy-lan-url");
    const list = byId("lan-address-list");
    const status = byId("lan-access-status");
    const note = byId("lan-url-note");
    const validAddress = (value) => {
      if (typeof value !== "string") return false;
      try {
        const parsed = new URL(value);
        return parsed.protocol === "http:" && /^\d+\.\d+\.\d+\.\d+$/.test(parsed.hostname) &&
          !parsed.username && !parsed.password && parsed.pathname === "/" && !parsed.search && !parsed.hash;
      } catch { return false; }
    };
    try {
      let runtime = { version: "0.2.0", lanUrls: ["http://192.168.31.73:3000"], recommendedUrl: "http://192.168.31.73:3000", relayEnabled: true };
      if (!isDemo) {
        const response = await fetch("/api/runtime", { cache: "no-store" });
        if (!response.ok) throw new Error("runtime unavailable");
        runtime = await response.json();
      }
      if (!Array.isArray(runtime.lanUrls) || !runtime.lanUrls.every(validAddress)) throw new Error("invalid address list");
      runtimeVersion = typeof runtime.version === "string" && /^\d+\.\d+\.\d+$/.test(runtime.version) ? runtime.version : "unknown";
      relayEnabled = runtime.relayEnabled === true;
      byId("shutdown-service-button").hidden = runtime.canShutdown !== true;
      const urls = [...new Set(runtime.lanUrls)].filter((url) => !new URL(url).hostname.startsWith("127."));
      const recommended = urls.includes(runtime.recommendedUrl) ? runtime.recommendedUrl : urls[0];
      if (!recommended) {
        byId("access-title").textContent = "目前仅本机可用";
        status.textContent = "目前仅本机可用：未找到局域网地址；localhost 只能在运行渡口服务的电脑上打开。";
        output.textContent = validAddress(runtime.recommendedUrl) && new URL(runtime.recommendedUrl).hostname.startsWith("127.")
          ? runtime.recommendedUrl : "仅本机地址，不能分享给另一台电脑";
        note.textContent = "请连接可互访的 Wi-Fi 或网线网络后刷新；本机地址不能用于其他电脑。";
        button.disabled = true;
      } else {
        status.textContent = "推荐地址 · 连接同一局域网后尝试打开；推荐不代表已验证可达。";
        output.textContent = recommended;
        button.disabled = false;
        button.addEventListener("click", () => void copyText(recommended, button));
        for (const url of urls.filter((value) => value !== recommended)) {
          const row = document.createElement("li");
          const address = document.createElement("output");
          address.textContent = url;
          const copy = document.createElement("button");
          copy.type = "button";
          copy.className = "text-button";
          copy.dataset.copyLanUrl = url;
          copy.textContent = "复制备选地址";
          copy.addEventListener("click", () => void copyText(url, copy));
          row.append(address, copy);
          list.append(row);
        }
        list.hidden = list.children.length === 0;
        note.textContent = "候选来自不同网卡，可能包含虚拟网卡；打不开时可试备选，并检查防火墙、访客 Wi-Fi 隔离或 VPN/TUN。渡口不会自动修改网络设置。";
      }
    } catch {
      byId("access-title").textContent = "暂时无法读取地址";
      status.textContent = "地址信息读取失败，不代表电脑没有局域网地址。";
      output.textContent = "请确认渡口服务仍在运行，然后刷新重试";
      note.textContent = "也可查看运行渡口的终端所显示的地址；当前页面地址未被当作其他电脑可用的入口。";
      button.disabled = true;
    }
    renderRelayAvailability();
  }

  byId("shutdown-service-button").addEventListener("click", async () => {
    const button = byId("shutdown-service-button");
    if (button.disabled) return;
    const warning = "关闭会结束所有电脑的房间与传输，并清理临时数据。尚未保存的接收文件会先保留并阻止关闭，请先保存或明确放弃。确定关闭渡口服务吗？";
    if (!window.confirm(warning)) return;
    button.disabled = true;
    button.textContent = "正在关闭…";
    shutdownStatus("正在等待各个页面清理连接和临时文件…");
    try {
      const response = await fetch("/api/shutdown", {
        method: "POST",
        headers: { "X-Dukou-Action": "shutdown" },
        signal: AbortSignal.timeout(15_000),
      });
      const result = await response.json();
      if (!response.ok || result.ok !== true) {
        const messages = {
          SHUTDOWN_UNSAVED_FILES: "仍有接收端文件未保存，服务暂未关闭。请先保存，或在接收端返回首页并确认放弃，然后重试关闭。",
          SHUTDOWN_CLEANUP_FAILED: "有页面的临时文件清理失败，服务暂未关闭。请保留相关页面并重试关闭。",
          SHUTDOWN_CLIENT_UNRESPONSIVE: "有页面未确认清理完成，服务暂未关闭。请让相关页面回到前台，等待文件操作结束后重试。",
        };
        throw new Error(messages[result.code] ?? "关闭请求未被接受，请从运行渡口电脑的本机地址重试。");
      }
      await releaseSession();
      await cleanShutdownResources();
      // The acknowledgement precedes actual process exit. Check that HTTP has
      // stopped before displaying the terminal notice, with no polling left behind.
      let stopped = false;
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        try {
          await fetch("/healthz", { cache: "no-store", signal: AbortSignal.timeout(500) });
        } catch {
          stopped = true;
          break;
        }
      }
      if (!stopped) throw new Error("页面资源已清理，但服务端口仍可访问，尚不能确认退出。请在本机检查运行窗口。");
      shutdownStatus("");
      byId("shutdown-notice").hidden = false;
    } catch (error) {
      button.disabled = false;
      button.textContent = "关闭渡口服务";
      shutdownStatus(error.name === "TimeoutError" || error.name === "TypeError"
        ? "关闭结果尚未确认，请检查本机运行窗口与各个接收页面后重试。"
        : error.message);
    }
  });

  renderSenderFiles();
  renderRelayAvailability();
  setStation(isDemo ? "online" : "offline");
  void initializeLanAccess();
})();
