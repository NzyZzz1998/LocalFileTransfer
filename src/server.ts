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
import { RelayHub } from "./relay-hub";

export const APP_VERSION = "0.2.0";

export interface ServerOptions {
  hostname?: string;
  port?: number;
  signalingConfig?: SignalingConfig;
  now?: () => number;
  nextRoomCode?: () => string;
  sweepIntervalMs?: number;
  networkInterfaces?: () => NetworkInterfaces;
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

export function startServer(options: ServerOptions = {}) {
  const config = options.signalingConfig ?? signalingConfig;
  const core = new SignalingCore(config, {
    now: options.now ?? Date.now,
    nextRoomCode:
      options.nextRoomCode ??
      (() => randomInt(0, 1_000_000).toString().padStart(6, "0")),
    nextRelayCredential: () => randomBytes(24).toString("base64url"),
  });
  const sockets = new Map<string, Bun.ServerWebSocket<SocketData>>();
  const relaySockets = new Map<string, Bun.ServerWebSocket<SocketData>>();
  const relayHub = new RelayHub({
    now: options.now ?? Date.now,
    credentialTtlMs: 60_000,
    maxFrameBytes: 256 * 1024,
  });
  const networkInterfaces = options.networkInterfaces ?? readNetworkInterfaces;
  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;

  const stop = (closeActiveConnections?: boolean) => {
    if (stopped) return;
    stopped = true;
    if (sweepTimer) clearInterval(sweepTimer);
    bunServer.stop(closeActiveConnections);
  };

  const dispatch = (actions: SignalingAction[]) => {
    for (const action of actions) {
      if (action.kind === "authorize_relay") {
        relayHub.authorize(action.sessionId, action.senderToken, action.receiverToken);
        continue;
      }
      const socket = sockets.get(action.peerId);
      if (!socket) continue;
      if (action.kind === "send") {
        socket.send(JSON.stringify(action.message));
      } else {
        socket.close(action.code, action.reason);
      }
    }
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
        const shutdownTimer = setTimeout(() => stop(true), 75);
        shutdownTimer.unref();
        return secureResponse(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json; charset=utf-8" },
        });
      }
      if (request.method !== "GET") {
        return secureResponse("Method not allowed", {
          status: 405,
          headers: { Allow: "GET" },
        });
      }
      if (pathname === "/relay") {
        if (request.headers.get("origin") !== requestUrl.origin) {
          return secureResponse("Forbidden WebSocket origin", { status: 403 });
        }
        const token = requestUrl.searchParams.get("token") ?? "";
        const connectionId = crypto.randomUUID();
        if (!relayHub.claim(token, connectionId)) {
          return secureResponse("Invalid or expired relay credential", { status: 403 });
        }
        if (server.upgrade(request, { data: { kind: "relay", connectionId } })) return;
        relayHub.disconnect(connectionId);
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
        return secureResponse(JSON.stringify({ ...runtime, canShutdown }), {
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
        if (socket.data.kind === "signaling") {
          sockets.set(socket.data.peerId, socket);
          return;
        }
        relaySockets.set(socket.data.connectionId, socket);
        const counterpartId = relayHub.counterpart(socket.data.connectionId);
        const counterpart = counterpartId ? relaySockets.get(counterpartId) : undefined;
        if (counterpart) {
          const ready = JSON.stringify({ type: "relay_open" });
          socket.send(ready);
          counterpart.send(ready);
        }
      },
      message(socket, message) {
        if (socket.data.kind === "relay") {
          if (typeof message === "string") {
            socket.close(1003, "binary relay frames only");
            return;
          }
          const payload = message instanceof Uint8Array ? message : new Uint8Array(message);
          try {
            relayHub.validateFrame(payload);
          } catch {
            socket.close(1009, "relay frame too large");
            return;
          }
          const counterpartId = relayHub.counterpart(socket.data.connectionId);
          const counterpart = counterpartId ? relaySockets.get(counterpartId) : undefined;
          if (counterpart) counterpart.send(payload);
          return;
        }
        const payload =
          typeof message === "string"
            ? message
            : message instanceof Uint8Array
              ? message
              : new Uint8Array(message);
        dispatch(core.receive(socket.data.peerId, payload));
      },
      close(socket) {
        if (socket.data.kind === "relay") {
          const counterpartId = relayHub.counterpart(socket.data.connectionId);
          relaySockets.delete(socket.data.connectionId);
          relayHub.disconnect(socket.data.connectionId);
          if (counterpartId) {
            relaySockets.get(counterpartId)?.close(1001, "relay peer left");
            relaySockets.delete(counterpartId);
          }
          return;
        }
        sockets.delete(socket.data.peerId);
        dispatch(core.disconnect(socket.data.peerId));
      },
      maxPayloadLength: Math.max(config.maxMessageBytes, 256 * 1024),
    },
  });
  sweepTimer = setInterval(
    () => {
      dispatch(core.sweepExpiredRooms());
      relayHub.sweep();
    },
    options.sweepIntervalMs ?? 1_000,
  );
  sweepTimer.unref();

  return {
    get url() {
      return bunServer.url;
    },
    get runtime() {
      return createRuntimeInfo(networkInterfaces(), bunServer.port, APP_VERSION);
    },
    stop(closeActiveConnections?: boolean) {
      stop(closeActiveConnections);
    },
  };
}

if (import.meta.main) {
  const hostname = Bun.env.HOST ?? "0.0.0.0";
  const port = Number(Bun.env.PORT ?? "3000");
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("PORT must be an integer between 0 and 65535");
  }
  const server = startServer({ hostname, port });
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
