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
  let sessionConnection = null;
  let realModules = null;
  let senderEngine = null;
  let receiverEngine = null;
  let directChannel = null;
  let roomActive = false;
  const metricsByPrefix = new Map();
  const lastProgressPaint = new Map();
  let isCleaningUp = false;
  let unloadCleanupStarted = false;
  const objectUrls = new Set();
  const TERMINAL_TRANSFER_STATES = new Set(["completed", "rejected", "cancelled", "failed"]);

  function announce(message) {
    liveRegion.textContent = message;
  }

  async function cleanupSink(sink) {
    try {
      await sink?.cleanup?.();
    } catch {
      // Cleanup is best-effort; a failed retry must not break the UI.
    }
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
      empty.textContent = "文件会列在这里；创建房间前仍可移除。";
      list.append(empty);
      summary.textContent = "尚未选择文件";
      createButton.disabled = true;
      return;
    }
    list.classList.remove("empty-list");
    const total = selectedFiles.reduce((sum, file) => sum + file.size, 0);
    summary.textContent = `${selectedFiles.length} 个文件 · ${formatBytes(total)}`;
    createButton.disabled = false;
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
      connecting: "正在连接配对站…",
      online: "配对站在线",
      offline: "配对站离线",
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
    if (event.code === "RELAY_UNAVAILABLE") return "本地中转目前不可用";
    if (event.code === "INVALID_SERVER_MESSAGE") return "配对站返回了无法识别的信息";
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
        RelayTransport: relayModule.RelayTransport,
      };
    }
    return realModules;
  }

  async function ensureSession(role) {
    if (session && sessionRole === role && sessionConnection) {
      await sessionConnection;
      return session;
    }
    if (session) await releaseSession();
    const modules = await loadRealModules();
    sessionRole = role;
    const nextSession = new modules.PeerSession({
      onEvent: (event) => {
        if (session === nextSession) handleSessionEvent(event);
      },
    });
    session = nextSession;
    sessionConnection = session.connect();
    try {
      await sessionConnection;
      return session;
    } catch (error) {
      sessionConnection = null;
      throw error;
    }
  }

  function enterSender() {
    showOnly(byId("sender-screen"));
    showSenderStage(byId("sender-prepare"));
    byId("sender-title").textContent = "选择要发送的文件";
    clearErrors();
    announce("已进入发送文件");
    if (!isDemo) void ensureSession("sender").catch(() => showError("sender", "暂时连接不上配对站"));
  }

  function enterReceiver() {
    showOnly(byId("receiver-screen"));
    showReceiverStage(byId("receiver-code-stage"));
    byId("receiver-title").textContent = "输入发送方的接收码";
    clearErrors();
    byId("join-code").focus();
    announce("已进入接收文件");
    if (!isDemo) void ensureSession("receiver").catch(() => showError("receiver", "暂时连接不上配对站"));
  }

  function isEngineActive(engine) {
    return engine && !TERMINAL_TRANSFER_STATES.has(engine.state) && engine.state !== "idle";
  }

  function hasActiveWork() {
    return roomActive || isEngineActive(senderEngine) || isEngineActive(receiverEngine);
  }

  function hasUnsavedFiles() {
    return (
      receiverEngine?.state === "completed" &&
      receiverEngine.receivedFiles.some((entry) => entry.saved !== true)
    );
  }

  async function cancelEngines() {
    const activeSender = senderEngine;
    const activeReceiver = receiverEngine;
    const previousCleanupState = isCleaningUp;
    isCleaningUp = true;
    try {
      activeSender?.cancel?.();
      await activeReceiver?.cancel?.();
    } catch {
      // Transport failure must not prevent browser-storage cleanup.
    } finally {
      isCleaningUp = previousCleanupState;
    }
  }

  async function releaseSession({ graceMs = 75 } = {}) {
    if (expiryTimer) clearInterval(expiryTimer);
    expiryTimer = null;
    const activeSession = session;
    const receivedFiles = [...(receiverEngine?.receivedFiles ?? [])];
    const shouldNotifyPeer = isEngineActive(senderEngine) || isEngineActive(receiverEngine);

    await cancelEngines();
    if (shouldNotifyPeer && graceMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, graceMs));
    }

    session = null;
    sessionRole = null;
    sessionConnection = null;
    senderEngine = null;
    receiverEngine = null;
    directChannel = null;
    roomActive = false;
    activeSession?.leave();
    await Promise.all(receivedFiles.map((entry) => cleanupSink(entry.sink)));
    for (const url of objectUrls) URL.revokeObjectURL(url);
    objectUrls.clear();
  }

  async function resetHome() {
    if (demoTimer) clearTimeout(demoTimer);
    if (progressTimer) clearInterval(progressTimer);
    if (!isDemo) {
      await releaseSession();
    }
    selectedFiles = [];
    byId("send-file-input").value = "";
    renderSenderFiles();
    byId("join-code").value = "";
    byId("join-room-button").disabled = true;
    byId("sender-progress").hidden = true;
    byId("sender-connected").hidden = true;
    clearErrors();
    showOnly(byId("home-screen"));
    announce("已返回首页");
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
    byId("sender-title").textContent = "把接收码告诉另一台电脑";
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
    byId("sender-connected").querySelector("small").textContent = "连接较慢时会在 20 秒停止并给出出口";
    byId("sender-route-timeline").hidden = false;
    byId("sender-route-fact").textContent = "正在寻找直连";
    byId("sender-encryption-fact").textContent = "尚未建立";
    announce("正在寻找局域网直连");
    demoTimer = setTimeout(() => {
      byId("sender-connected").hidden = true;
      byId("sender-route-timeline").hidden = true;
      byId("sender-route-failed").hidden = false;
      byId("sender-route-fact").textContent = "直连超时 · 未改路";
      announce("直连没有建立，可以重试或申请本地中转");
    }, 650);
  }

  async function renderReceiverManifest(manifest) {
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
    const capability = isDemo
      ? { mode: "memory", allowed: true, limitBytes: MAX_MEMORY_BYTES }
      : await realModules.assessStorageCapability(files, navigator, MAX_MEMORY_BYTES);
    if (!capability.allowed) {
      contract.innerHTML = `<b>无法接收这批文件</b>${capability.code === "FILE_TOO_LARGE" ? "存在超过 256 MiB 的文件" : "本批文件总量超过 256 MiB"}；当前浏览器只能使用内存接收。`;
      showError("receiver", "容量预检未通过，尚未接收任何文件内容");
    } else {
      contract.innerHTML = capability.mode === "opfs"
        ? "<b>浏览器存储模式</b>本批将写入浏览器临时文件，完成后仍需手动保存。"
        : "<b>内存接收模式</b>单个文件与本批总量上限均为 256 MiB；本批已通过容量预检。";
      acceptButton.disabled = false;
    }
    announce("收到一份文件清单，请确认");
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
      byId("receiver-title").textContent = "确认是否改走本地中转";
      byId("receiver-route-fact").textContent = "等待你确认改路";
      announce("发送方请求改用本地中转");
    }, 600);
  }

  function renderReceivedFiles(entries) {
    showReceiverStage(byId("receiver-complete"));
    byId("receiver-title").textContent = "文件已经靠岸";
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
          setTimeout(() => {
            URL.revokeObjectURL(url);
            objectUrls.delete(url);
            void cleanupSink(entry.sink);
          }, 5_000);
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

  function setupReceiver(channel) {
    if (receiverEngine) return;
    receiverEngine = new realModules.ReceiverEngine(channel, {
      createSink: (file) => realModules.createStorage({ ...file, maxMemoryBytes: MAX_MEMORY_BYTES, navigator }),
      onManifest: (manifest) => void renderReceiverManifest(manifest),
      onProgress: (progress) => updateProgress("receiver", progress),
      onState: (state) => {
        if (state === "receiving") {
          showReceiverStage(byId("receiver-progress"));
          byId("receiver-title").textContent = "正在摆渡";
        }
        if (state === "completed") {
          roomActive = false;
          renderReceivedFiles(receiverEngine.receivedFiles);
        }
        if (state === "rejected") roomActive = false;
        if (state === "cancelled" && !isCleaningUp) {
          roomActive = false;
          showError("receiver", "发送方取消了这次传输");
        }
        if (state === "failed") {
          roomActive = false;
          showError("receiver", "传输数据异常，本次传输已停止");
        }
      },
    });
  }

  function setupSender(channel) {
    if (senderEngine) return;
    senderEngine = new realModules.SenderEngine(channel, {
      onProgress: (progress) => updateProgress("sender", progress),
      onState: (state) => {
        if (state === "awaiting_acceptance") {
          byId("sender-connected").hidden = false;
          byId("sender-connected").querySelector("strong").textContent = "等待对方确认文件";
        }
        if (state === "transferring") {
          byId("sender-connected").hidden = true;
          byId("sender-progress").hidden = false;
          byId("sender-title").textContent = "正在摆渡";
        }
        if (state === "completed") {
          roomActive = false;
          byId("sender-progress").hidden = false;
          byId("sender-progress-percent").textContent = "100%";
          byId("sender-title").textContent = "文件已送达";
          announce("文件已全部送达");
        }
        if (state === "rejected") {
          roomActive = false;
          showError("sender", "对方没有接收这批文件");
        }
        if (state === "cancelled" && !isCleaningUp) {
          roomActive = false;
          showError("sender", "接收方取消了这次传输");
        }
        if (state === "failed") {
          roomActive = false;
          showError("sender", "文件传输失败，请重新开始");
        }
      },
    });
    senderEngine.send(selectedFiles).catch(() => showError("sender", "文件传输失败，请重新开始"));
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
    if (failedRole === "receiver") {
      showReceiverStage(byId("receiver-code-stage"));
      byId("receiver-title").textContent = "这次连接已经结束";
    }
    showError(failedRole, message);
    void releaseSession({ graceMs: 0 });
  }

  function handleSessionEvent(event) {
    if (event.type === "signaling") {
      setStation(event.state);
      if (event.state === "offline" && roomActive && !directChannel) {
        stopAfterConnectionFailure("配对站连接已断开，请重新开始");
      }
      return;
    }
    if (event.type === "room_created") {
      roomActive = true;
      showSenderStage(byId("sender-waiting"));
      byId("sender-title").textContent = "把接收码告诉另一台电脑";
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
      announce("连接比平时慢，仍在寻找局域网路线");
      return;
    }
    if (event.type === "data_channel" && event.state === "open") {
      directChannel = event.channel;
      if (sessionRole === "receiver") setupReceiver(event.channel);
      return;
    }
    if (event.type === "data_channel" && event.state === "closed") {
      stopAfterConnectionFailure("连接已断开，本次传输无法继续");
      return;
    }
    if (event.type === "peer_connection") {
      if (event.state === "failed" || event.state === "closed") {
        if (directChannel) stopAfterConnectionFailure("局域网直连已中断，本次传输无法继续");
        else if (sessionRole === "sender") {
          byId("sender-connected").hidden = true;
          byId("sender-route-timeline").hidden = true;
          byId("sender-route-failed").hidden = false;
        }
      } else if (event.state === "disconnected" && hasActiveWork()) {
        announce("局域网连接暂时中断，正在尝试恢复");
      }
      return;
    }
    if (event.type === "relay_requested") {
      showReceiverStage(byId("receiver-relay-consent"));
      byId("receiver-title").textContent = "确认是否改走本地中转";
      byId("receiver-route-fact").textContent = "等待你确认改路";
      announce("发送方请求改用本地中转");
      return;
    }
    if (event.type === "relay_declined") {
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
      if (!event.direct) {
        if (sessionRole === "sender") {
          byId("sender-connected").hidden = true;
          byId("sender-route-failed").hidden = false;
          byId("sender-route-fact").textContent = "直连路线未通过验证";
        }
        announce("直连路线未通过验证，尚未发送文件内容");
        return;
      }
      const routeFact = byId(sessionRole === "sender" ? "sender-route-fact" : "receiver-route-fact");
      const encryptionFact = byId(sessionRole === "sender" ? "sender-encryption-fact" : "receiver-encryption-fact");
      routeFact.textContent = "局域网直连";
      encryptionFact.textContent = "已建立";
      if (sessionRole === "sender" && directChannel) setupSender(directChannel);
      return;
    }
    if (event.type === "room_expired") {
      stopAfterConnectionFailure("接收码已过期，请重新开始");
      return;
    }
    if (event.type === "peer_left" || event.type === "room_closed") {
      stopAfterConnectionFailure("连接已断开，本次传输无法继续");
      return;
    }
    if (event.type === "error") {
      const message = errorMessage(event);
      if (event.code === "DIRECT_TIMEOUT" && sessionRole === "sender") {
        byId("sender-connected").hidden = true;
        byId("sender-route-timeline").hidden = true;
        byId("sender-route-failed").hidden = false;
        byId("sender-route-fact").textContent = "直连超时 · 未改路";
        announce("直连超时，尚未发送文件；可以重试或申请本地中转");
      } else if (event.code === "DIRECT_TIMEOUT" && sessionRole === "receiver") {
        byId("receiver-searching").querySelector("h3").textContent = "直连未成功";
        byId("receiver-searching").querySelector("p:last-child").textContent = "等待发送方重试或申请本地中转";
      } else if (event.code === "RTC_NEGOTIATION_FAILED") {
        stopAfterConnectionFailure(message);
      } else {
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
    try {
      const modules = await loadRealModules();
      const transport = new modules.RelayTransport({ token: event.token });
      await transport.connect();
      directChannel = transport;
      if (sessionRole === "sender") {
        byId("sender-relay-pending").hidden = true;
        byId("sender-route-fact").textContent = "本地中转";
        byId("sender-encryption-fact").textContent = "应用层加密";
        byId("sender-relay-fact").textContent = "双方已确认";
        setupSender(transport);
      } else {
        byId("receiver-route-fact").textContent = "本地中转";
        byId("receiver-encryption-fact").textContent = "应用层加密";
        byId("receiver-connection-status").textContent = "本地中转";
        setupReceiver(transport);
      }
      announce("本地中转加密通道已建立");
    } catch {
      showError(sessionRole, "本地中转加密通道建立失败");
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
    byId("receiver-title").textContent = "文件已经靠岸";
    const files = byId("received-files");
    files.replaceChildren();
    const row = document.createElement("div");
    row.className = "received-file";
    const name = document.createElement("span");
    name.textContent = "设计素材包.zip";
    const save = document.createElement("button");
    save.className = "primary-button";
    save.type = "button";
    save.textContent = "保存到电脑";
    save.setAttribute("aria-label", "保存 设计素材包.zip");
    save.addEventListener("click", () => announce("演示模式不会写入文件"));
    row.append(name, save);
    files.append(row);
    announce("接收完成，请保存文件");
  }

  function startDemoReceive() {
    showReceiverStage(byId("receiver-progress"));
    byId("receiver-title").textContent = "正在摆渡";
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
    senderEngine?.cancel?.();
    const cancellation = receiverEngine?.cancel?.();
    if (cancellation && typeof cancellation.catch === "function") {
      cancellation.catch(() => {});
    }
    for (const entry of receiverEngine?.receivedFiles ?? []) {
      void cleanupSink(entry.sink);
    }
    session?.leave();
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
    try {
      (await ensureSession("sender")).createRoom();
    } catch {
      showError("sender", "暂时无法生成接收码，请稍后重试");
      button.disabled = false;
    } finally {
      button.textContent = "生成接收码";
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
    void releaseSession({ graceMs: 0 })
      .then(() => ensureSession("sender"))
      .then((activeSession) => activeSession.createRoom())
      .catch(() => showError("sender", "重试失败，暂时连接不上配对站"));
  });

  byId("copy-diagnostic-button").addEventListener("click", async () => {
    const diagnostic = JSON.stringify({
      version: "0.2.0",
      error: "DIRECT_TIMEOUT",
      stage: "direct_connecting",
      elapsedMs: 20_000,
      signaling: "online_before_timeout",
    }, null, 2);
    try {
      await navigator.clipboard.writeText(diagnostic);
      byId("copy-diagnostic-button").textContent = "诊断已复制";
      announce("已复制不含房间码、IP 和文件名的诊断信息");
    } catch {
      announce("无法自动复制诊断，请检查浏览器剪贴板权限");
    }
  });

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
    byId("receiver-title").textContent = "正在查找这趟传输";
    try {
      (await ensureSession("receiver")).joinRoom(code);
    } catch {
      showReceiverStage(byId("receiver-code-stage"));
      showError("receiver", "暂时连接不上配对站");
    }
  });

  byId("approve-relay-button").addEventListener("click", () => {
    if (isDemo) renderDemoOffer();
    else session?.approveRelay();
  });
  byId("reject-relay-button").addEventListener("click", () => {
    if (isDemo) void resetHome();
    else {
      session?.rejectRelay();
      void resetHome();
    }
  });

  byId("accept-files-button").addEventListener("click", () => {
    if (isDemo) startDemoReceive();
    else if (receiverEngine?.state === "awaiting_acceptance") receiverEngine.accept();
    else showError("receiver", "这批文件已经不能接收，请重新连接");
  });
  byId("reject-files-button").addEventListener("click", () => {
    if (isDemo) void resetHome();
    else if (receiverEngine?.state === "awaiting_acceptance") {
      receiverEngine.reject();
      setTimeout(() => void resetHome(), 100);
    } else showError("receiver", "这批文件的状态已经变化，请重新连接");
  });
  byId("cancel-transfer-button").addEventListener("click", () => void cancelCurrentTransfer());
  addEventListener("pagehide", bestEffortPageExitCleanup);
  addEventListener("beforeunload", bestEffortPageExitCleanup);

  async function initializeLanAccess() {
    const output = byId("lan-url");
    const button = byId("copy-lan-url");
    let url = isDemo ? "http://192.168.31.73:3000" : "";
    let canShutdown = false;
    if (!isDemo) {
      try {
        const response = await fetch("/api/runtime", { cache: "no-store" });
        if (response.ok) {
          const runtime = await response.json();
          url = runtime.recommendedUrl ?? "";
          canShutdown = runtime.canShutdown === true;
        }
      } catch {
        // Runtime endpoint is delivered in the implementation batch; localhost remains usable meanwhile.
      }
    }
    if (!url && location.protocol !== "file:") url = location.origin;
    if (!url) {
      output.textContent = "暂未找到可访问的局域网地址";
      return;
    }
    output.textContent = url;
    button.disabled = false;
    byId("shutdown-service-button").hidden = !canShutdown;
    button.addEventListener("click", async () => {
      try {
        if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
        await navigator.clipboard.writeText(url);
        button.textContent = "已复制";
      } catch {
        output.setAttribute("tabindex", "0");
        output.focus();
        announce("无法自动复制，请手动复制地址");
      }
    });
  }

  byId("shutdown-service-button").addEventListener("click", async () => {
    const warning = hasActiveWork()
      ? "当前还有房间或传输，关闭会立即断开另一台电脑。确定关闭整个渡口吗？"
      : "关闭后其他电脑将无法打开渡口。确定关闭整个渡口吗？";
    if (!window.confirm(warning)) return;
    const button = byId("shutdown-service-button");
    button.disabled = true;
    button.textContent = "正在关闭…";
    try {
      const response = await fetch("/api/shutdown", {
        method: "POST",
        headers: { "X-Dukou-Action": "shutdown" },
      });
      if (!response.ok) throw new Error("shutdown rejected");
      byId("shutdown-notice").hidden = false;
    } catch {
      button.disabled = false;
      button.textContent = "关闭渡口服务";
      announce("未能关闭渡口，请回到运行窗口按 Ctrl+C");
    }
  });

  renderSenderFiles();
  setStation(isDemo ? "online" : "offline");
  void initializeLanAccess();
})();
