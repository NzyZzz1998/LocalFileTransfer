import { randomBytes, randomInt } from "node:crypto";
import { networkInterfaces as readNetworkInterfaces } from "node:os";
import indexHtml from "./web/index.html" with { type: "text" };
import appCss from "./web/app.css" with { type: "text" };
import appJs from "./web/app.js" with { type: "text" };
import peerSessionJs from "./web/peer-session.js" with { type: "text" };
import transferJs from "./web/transfer.js" with { type: "text" };
import storageJs from "./web/storage.js" with { type: "text" };
import relayCryptoJs from "./web/relay-crypto.js" with { type: "text" };
import relayTransportJs from "./web/relay-transport.js" with { type: "text" };
import naclFastJs from "../node_modules/tweetnacl/nacl-fast.min.js" with { type: "text" };
import {
  SignalingCore,
  type SignalingAction,
  type SignalingConfig,
} from "./signaling-core";
import { createRuntimeInfo, type NetworkInterfaces } from "./runtime-info";
import { RelayHub, RELAY_DEFAULTS, type RelayClosure, type RelayHubOptions } from "./relay-hub";
import { RelayBackpressure, RELAY_QUEUE_DEFAULTS, type RelayQueueOptions } from "./relay-backpressure";

export const APP_VERSION = "0.2.0";

export interface ServerOptions {
  hostname?: string;
  port?: number;
  signalingConfig?: SignalingConfig;
  now?: () => number;
  nextRoomCode?: () => string;
  sweepIntervalMs?: number;
  networkInterfaces?: () => NetworkInterfaces;
  relayEnabled?: boolean;
  relayConfig?: Partial<Omit<RelayHubOptions, "now"> & RelayQueueOptions>;
  shutdownTimeoutMs?: number;
  onShutdownComplete?: () => void;
}

interface SignalingSocketData {
  kind: "signaling";
  peerId: string;
  clientKey: string;
}

interface RelaySocketData {
  kind: "relay";
  connectionId: string;
}

type SocketData = SignalingSocketData | RelaySocketData;

type ShutdownStatus = "pending" | "ready" | "unsaved" | "cleanup_failed" | "unresponsive";
type ShutdownResult = { ok: true } | {
  ok: false;
  code: "SHUTDOWN_UNSAVED_FILES" | "SHUTDOWN_CLEANUP_FAILED" | "SHUTDOWN_CLIENT_UNRESPONSIVE";
};

interface ShutdownAttempt {
  requestId: string;
  peers: Map<string, ShutdownStatus>;
  promise: Promise<ShutdownResult>;
  resolve: (result: ShutdownResult) => void;
  timer?: ReturnType<typeof setTimeout>;
  completed: boolean;
}

const signalingConfig: SignalingConfig = {
  roomTtlMs: 600_000,
  maxMessageBytes: 65_536,
  joinRateLimit: { maxAttempts: 5, windowMs: 60_000 },
};

const staticAssets = new Map([
  ["/", { body: indexHtml, type: "text/html; charset=utf-8" }],
  ["/index.html", { body: indexHtml, type: "text/html; charset=utf-8" }],
  ["/app.css", { body: appCss, type: "text/css; charset=utf-8" }],
  ["/app.js", { body: appJs, type: "text/javascript; charset=utf-8" }],
  ["/peer-session.js", { body: peerSessionJs, type: "text/javascript; charset=utf-8" }],
  ["/transfer.js", { body: transferJs, type: "text/javascript; charset=utf-8" }],
  ["/storage.js", { body: storageJs, type: "text/javascript; charset=utf-8" }],
  ["/relay-crypto.js", { body: relayCryptoJs, type: "text/javascript; charset=utf-8" }],
  ["/relay-transport.js", { body: relayTransportJs, type: "text/javascript; charset=utf-8" }],
  ["/vendor/tweetnacl.js", { body: naclFastJs, type: "text/javascript; charset=utf-8" }],
] as const);

const securityHeaders = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
} as const;

function secureResponse(body: BodyInit | null, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  for (const [name, value] of Object.entries(securityHeaders)) {
    headers.set(name, value);
  }
  return new Response(body, { ...init, headers });
}

export function isLoopbackAddress(address: string | undefined): boolean {
  return address === "::1" || address === "127.0.0.1" || address === "::ffff:127.0.0.1";
}

export function parseRelayEnabled(value: string | undefined): boolean {
  if (value === undefined) return true;
  if (["true", "1"].includes(value.trim().toLowerCase())) return true;
  if (["false", "0"].includes(value.trim().toLowerCase())) return false;
  throw new Error("RELAY_ENABLED must be true, false, 1 or 0");
}

export function startServer(options: ServerOptions = {}) {
  const relayEnabled = options.relayEnabled ?? options.signalingConfig?.relayEnabled ?? parseRelayEnabled(Bun.env.RELAY_ENABLED);
  const config = { ...(options.signalingConfig ?? signalingConfig), relayEnabled };
  const core = new SignalingCore(config, {
    now: options.now ?? Date.now,
    nextRoomCode:
      options.nextRoomCode ??
      (() => randomInt(0, 1_000_000).toString().padStart(6, "0")),
    nextRelayCredential: () => randomBytes(24).toString("base64url"),
  });
  const sockets = new Map<string, Bun.ServerWebSocket<SocketData>>();
  const relaySockets = new Map<string, Bun.ServerWebSocket<SocketData>>();
  const relayConfig = { ...RELAY_DEFAULTS, ...RELAY_QUEUE_DEFAULTS, ...options.relayConfig };
  const relayHub = new RelayHub({
    ...relayConfig,
    now: options.now ?? Date.now,
  });
  const relayBackpressure = new RelayBackpressure({
    maxSocketBytes: relayConfig.maxSocketBytes,
    maxSessionBytes: relayConfig.maxSessionBytes,
    maxTotalBytes: relayConfig.maxTotalBytes,
  });
  const networkInterfaces = options.networkInterfaces ?? readNetworkInterfaces;
  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
  let shutdownAttempt: ShutdownAttempt | undefined;
  let stopped = false;

  const stop = async (closeActiveConnections?: boolean) => {
    if (stopped) return;
    stopped = true;
    if (sweepTimer) clearInterval(sweepTimer);
    if (shutdownTimer) clearTimeout(shutdownTimer);
    if (shutdownAttempt && !shutdownAttempt.completed) finishShutdown(shutdownAttempt, true);
    await bunServer.stop(closeActiveConnections);
  };

  const finishShutdown = (attempt: ShutdownAttempt, timedOut = false) => {
    if (attempt.completed) return;
    const statuses = [...attempt.peers.values()];
    if (!timedOut && statuses.includes("pending")) return;
    const code = statuses.includes("unsaved")
      ? "SHUTDOWN_UNSAVED_FILES"
      : statuses.includes("cleanup_failed")
        ? "SHUTDOWN_CLEANUP_FAILED"
        : timedOut || statuses.includes("unresponsive")
          ? "SHUTDOWN_CLIENT_UNRESPONSIVE"
          : undefined;
    attempt.completed = true;
    if (attempt.timer) clearTimeout(attempt.timer);
    // Failed attempts release the admission gate so clients can save files and retry.
    if (code) shutdownAttempt = undefined;
    attempt.resolve(code ? { ok: false, code } : { ok: true });
  };

  const requestShutdown = (): Promise<ShutdownResult> => {
    if (shutdownAttempt) return shutdownAttempt.promise;
    const { promise, resolve } = Promise.withResolvers<ShutdownResult>();
    const attempt: ShutdownAttempt = {
      requestId: crypto.randomUUID(),
      peers: new Map([...sockets.keys()].map((peerId) => [peerId, "pending"])),
      promise,
      resolve,
      completed: false,
    };
    shutdownAttempt = attempt;
    attempt.timer = setTimeout(() => finishShutdown(attempt, true), options.shutdownTimeoutMs ?? 10_000);
    attempt.timer.unref();
    const notice = JSON.stringify({ type: "service_shutdown", requestId: attempt.requestId });
    for (const [peerId, socket] of sockets) {
      try {
        if (socket.send(notice) === 0) attempt.peers.set(peerId, "unresponsive");
      } catch {
        attempt.peers.set(peerId, "unresponsive");
      }
    }
    finishShutdown(attempt);
    return promise;
  };

  const receiveShutdownAck = (peerId: string, payload: string | Uint8Array): boolean => {
    // Control frames have a narrow shape and cannot bypass signaling size/binary limits.
    if (typeof payload !== "string" || payload.length > 256 ||
      new TextEncoder().encode(payload).byteLength > Math.min(256, config.maxMessageBytes)) return false;
    let message: unknown;
    try {
      message = JSON.parse(payload);
    } catch {
      return false;
    }
    if (typeof message !== "object" || message === null || !("type" in message) || message.type !== "shutdown_ack") return false;
    const ack = message as Record<string, unknown>;
    const attempt = shutdownAttempt;
    if (Object.keys(ack).length === 3 && typeof ack.requestId === "string" &&
      (ack.status === "ready" || ack.status === "unsaved" || ack.status === "cleanup_failed") &&
      attempt && !attempt.completed && ack.requestId === attempt.requestId && attempt.peers.get(peerId) === "pending") {
      attempt.peers.set(peerId, ack.status);
      finishShutdown(attempt);
    }
    // Stale, duplicate, and malformed acknowledgements never reach room signaling.
    return true;
  };

  const dispatch = (actions: SignalingAction[]) => {
    const rejectedTokens = new Set<string>();
    for (const action of actions) {
      if (action.kind === "authorize_relay") {
        if (!relayEnabled || !relayHub.authorize(
          action.sessionId, action.senderToken, action.receiverToken, action.roomCode, action.clientKeys,
        )) {
          rejectedTokens.add(action.senderToken);
          rejectedTokens.add(action.receiverToken);
          dispatch(core.relayEnded(action.roomCode, action.sessionId, relayEnabled ? "RELAY_LIMIT" : "RELAY_DISABLED"));
        }
        continue;
      }
      if (action.kind === "revoke_relay") {
        finishRelay(relayHub.revokeRoom(action.roomCode, "RELAY_CLOSED", action.sessionId));
        continue;
      }
      const socket = sockets.get(action.peerId);
      if (!socket) continue;
      if (action.kind === "send") {
        if (action.message.type === "relay_ready" && rejectedTokens.has(action.message.token)) continue;
        socket.send(JSON.stringify(action.message));
      } else {
        socket.close(action.code, action.reason);
      }
    }
  };

  const finishRelay = (closure: RelayClosure | null) => {
    if (!closure) return;
    // Remove all indexes before closing sockets: re-entrant close events cannot affect a replacement session.
    for (const connectionId of closure.connectionIds) {
      const socket = relaySockets.get(connectionId);
      relaySockets.delete(connectionId);
      relayBackpressure.remove(connectionId);
      socket?.close(4000, closure.reason);
    }
    dispatch(core.relayEnded(
      closure.roomCode, closure.sessionId, closure.reason === "RELAY_CLOSED" ? undefined : closure.reason,
    ));
  };

  const sendRelay = (connectionId: string, frame: string | Uint8Array): boolean => {
    const socket = relaySockets.get(connectionId);
    const sessionId = relayHub.sessionIdFor(connectionId);
    if (!socket || !sessionId) return false;
    if (!relayBackpressure.send(connectionId, sessionId, socket, frame)) {
      finishRelay(relayHub.disconnect(connectionId, "RELAY_LIMIT"));
      return false;
    }
    return true;
  };

  const bunServer = Bun.serve<SocketData>({
    hostname: options.hostname ?? "0.0.0.0",
    port: options.port ?? 3000,
    async fetch(request, server) {
      const requestUrl = new URL(request.url);
      const pathname = requestUrl.pathname;
      if (pathname === "/api/shutdown") {
        const requestAddress = server.requestIP(request)?.address;
        const authorized =
          request.method === "POST" &&
          isLoopbackAddress(requestAddress) &&
          request.headers.get("origin") === requestUrl.origin &&
          request.headers.get("x-dukou-action") === "shutdown";
        if (!authorized) return secureResponse("Shutdown is only available locally", { status: 403 });
        const result = await requestShutdown();
        if (result.ok && !shutdownTimer) {
          // Let all joined HTTP responses reach their callers before stopping the listener.
          shutdownTimer = setTimeout(async () => {
            await stop(true);
            options.onShutdownComplete?.();
          }, 75);
          shutdownTimer.unref();
        }
        return secureResponse(JSON.stringify(result), {
          status: result.ok ? 200 : 409,
          headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
        });
      }
      if (request.method !== "GET") {
        return secureResponse("Method not allowed", {
          status: 405,
          headers: { Allow: "GET" },
        });
      }
      if ((pathname === "/ws" || pathname === "/relay") && (shutdownAttempt || stopped)) {
        return secureResponse("Service shutdown in progress", { status: 503, headers: { "Retry-After": "1" } });
      }
      if (pathname === "/relay") {
        if (!relayEnabled) return secureResponse("RELAY_DISABLED", { status: 503 });
        if (request.headers.get("origin") !== requestUrl.origin) {
          return secureResponse("Forbidden WebSocket origin", { status: 403 });
        }
        const token = requestUrl.searchParams.get("token") ?? "";
        const connectionId = crypto.randomUUID();
        for (const closure of relayHub.sweep()) finishRelay(closure);
        if (!relayHub.claim(token, connectionId)) {
          return secureResponse("Invalid or expired relay credential", { status: 403 });
        }
        if (server.upgrade(request, { data: { kind: "relay", connectionId } })) return;
        finishRelay(relayHub.disconnect(connectionId));
        return secureResponse("WebSocket upgrade required", { status: 426 });
      }
      if (pathname === "/ws") {
        if (request.headers.get("origin") !== requestUrl.origin) {
          return secureResponse("Forbidden WebSocket origin", { status: 403 });
        }
        const peerId = crypto.randomUUID();
        const clientKey = server.requestIP(request)?.address ?? "unknown";
        if (!core.connect({ id: peerId, clientKey })) {
          return secureResponse("Signaling capacity reached", {
            status: 503,
            headers: { "Retry-After": "1" },
          });
        }
        if (server.upgrade(request, { data: { kind: "signaling", peerId, clientKey } })) return;
        core.disconnect(peerId);
        return secureResponse("WebSocket upgrade required", { status: 426 });
      }
      if (request.method === "GET" && pathname === "/healthz") {
        return secureResponse(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json; charset=utf-8" },
        });
      }
      if (pathname === "/api/runtime") {
        const runtime = createRuntimeInfo(networkInterfaces(), bunServer.port, APP_VERSION);
        const canShutdown = isLoopbackAddress(server.requestIP(request)?.address);
        return secureResponse(JSON.stringify({ ...runtime, canShutdown, relayEnabled }), {
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
          },
        });
      }
      if (pathname === "/favicon.ico") {
        return secureResponse(null, { status: 204 });
      }
      const asset = staticAssets.get(pathname);
      if (request.method === "GET" && asset) {
        return secureResponse(asset.body, {
          headers: { "Content-Type": asset.type },
        });
      }
      return secureResponse("Not found", { status: 404 });
    },
    websocket: {
      open(socket) {
        if (shutdownAttempt || stopped) {
          socket.close(1001, "Service shutdown in progress");
          return;
        }
        if (socket.data.kind === "signaling") {
          sockets.set(socket.data.peerId, socket);
          return;
        }
        if (!relayHub.sessionIdFor(socket.data.connectionId)) {
          socket.close(4000, "RELAY_CLOSED");
          return;
        }
        relaySockets.set(socket.data.connectionId, socket);
        const counterpartId = relayHub.counterpart(socket.data.connectionId);
        const counterpart = counterpartId ? relaySockets.get(counterpartId) : undefined;
        if (counterpart) {
          const ready = JSON.stringify({ type: "relay_open" });
          if (sendRelay(socket.data.connectionId, ready)) sendRelay(counterpartId!, ready);
        }
      },
      message(socket, message) {
        if (socket.data.kind === "relay") {
          if (typeof message === "string") {
            finishRelay(relayHub.disconnect(socket.data.connectionId, "RELAY_PROTOCOL"));
            return;
          }
          const payload = message instanceof Uint8Array ? message : new Uint8Array(message);
          try {
            relayHub.validateFrame(payload);
          } catch {
            finishRelay(relayHub.disconnect(socket.data.connectionId, "RELAY_LIMIT"));
            return;
          }
          if (!relayHub.touch(socket.data.connectionId)) {
            finishRelay(relayHub.disconnect(socket.data.connectionId, "RELAY_TIMEOUT"));
            return;
          }
          const counterpartId = relayHub.counterpart(socket.data.connectionId);
          const counterpart = counterpartId ? relaySockets.get(counterpartId) : undefined;
          if (counterpart) sendRelay(counterpartId!, payload);
          else finishRelay(relayHub.disconnect(socket.data.connectionId, "RELAY_NOT_READY"));
          return;
        }
        const payload =
          typeof message === "string"
            ? message
            : message instanceof Uint8Array
              ? message
              : new Uint8Array(message);
        if (receiveShutdownAck(socket.data.peerId, payload)) return;
        dispatch(core.receive(socket.data.peerId, payload));
      },
      drain(socket) {
        if (socket.data.kind !== "relay") return;
        relayBackpressure.drain(socket.data.connectionId);
        if (!relayHub.touch(socket.data.connectionId)) {
          finishRelay(relayHub.disconnect(socket.data.connectionId, "RELAY_TIMEOUT"));
        }
      },
      close(socket, code) {
        if (socket.data.kind === "relay") {
          relaySockets.delete(socket.data.connectionId);
          relayBackpressure.remove(socket.data.connectionId);
          finishRelay(relayHub.disconnect(socket.data.connectionId, code === 1009 ? "RELAY_LIMIT" : "RELAY_CLOSED"));
          return;
        }
        sockets.delete(socket.data.peerId);
        if (shutdownAttempt?.peers.get(socket.data.peerId) === "pending") {
          shutdownAttempt.peers.set(socket.data.peerId, "unresponsive");
          finishShutdown(shutdownAttempt);
        }
        dispatch(core.disconnect(socket.data.peerId));
      },
      maxPayloadLength: Math.max(config.maxMessageBytes, relayConfig.maxFrameBytes),
      backpressureLimit: relayConfig.maxSocketBytes,
      closeOnBackpressureLimit: false,
    },
  });
  sweepTimer = setInterval(
    () => {
      dispatch(core.sweepExpiredRooms());
      for (const closure of relayHub.sweep()) finishRelay(closure);
    },
    options.sweepIntervalMs ?? 1_000,
  );
  sweepTimer.unref();

  return {
    get url() {
      return bunServer.url;
    },
    get runtime() {
      return { ...createRuntimeInfo(networkInterfaces(), bunServer.port, APP_VERSION), relayEnabled };
    },
    stop(closeActiveConnections?: boolean) {
      return stop(closeActiveConnections);
    },
  };
}

if (import.meta.main) {
  const hostname = Bun.env.HOST ?? "0.0.0.0";
  const port = Number(Bun.env.PORT ?? "3000");
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("PORT must be an integer between 0 and 65535");
  }
  const server = startServer({ hostname, port, onShutdownComplete: () => process.exit(0) });
  console.log(`渡口已启动：${server.url}`);
  if (server.runtime.lanUrls.length > 0) {
    console.log(`另一台电脑打开：${server.runtime.recommendedUrl}`);
    for (const candidate of server.runtime.lanUrls.slice(1)) {
      console.log(`其他网卡地址：${candidate}`);
    }
  } else {
    console.log("未找到局域网 IPv4 地址；目前只能在本机打开。");
  }
}
