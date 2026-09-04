import { randomInt } from "node:crypto";
import indexHtml from "./web/index.html" with { type: "text" };
import appCss from "./web/app.css" with { type: "text" };
import appJs from "./web/app.js" with { type: "text" };
import peerSessionJs from "./web/peer-session.js" with { type: "text" };
import transferJs from "./web/transfer.js" with { type: "text" };
import storageJs from "./web/storage.js" with { type: "text" };
import {
  SignalingCore,
  type SignalingAction,
  type SignalingConfig,
} from "./signaling-core";

export interface ServerOptions {
  hostname?: string;
  port?: number;
  signalingConfig?: SignalingConfig;
  now?: () => number;
  nextRoomCode?: () => string;
  sweepIntervalMs?: number;
}

interface SocketData {
  peerId: string;
  clientKey: string;
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

export function startServer(options: ServerOptions = {}) {
  const config = options.signalingConfig ?? signalingConfig;
  const core = new SignalingCore(config, {
    now: options.now ?? Date.now,
    nextRoomCode:
      options.nextRoomCode ??
      (() => randomInt(0, 1_000_000).toString().padStart(6, "0")),
  });
  const sockets = new Map<string, Bun.ServerWebSocket<SocketData>>();

  const dispatch = (actions: SignalingAction[]) => {
    for (const action of actions) {
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
    fetch(request, server) {
      const requestUrl = new URL(request.url);
      const pathname = requestUrl.pathname;
      if (request.method !== "GET") {
        return secureResponse("Method not allowed", {
          status: 405,
          headers: { Allow: "GET" },
        });
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
        if (server.upgrade(request, { data: { peerId, clientKey } })) return;
        core.disconnect(peerId);
        return secureResponse("WebSocket upgrade required", { status: 426 });
      }
      if (request.method === "GET" && pathname === "/healthz") {
        return secureResponse(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json; charset=utf-8" },
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
        sockets.set(socket.data.peerId, socket);
      },
      message(socket, message) {
        const payload =
          typeof message === "string"
            ? message
            : message instanceof Uint8Array
              ? message
              : new Uint8Array(message);
        dispatch(core.receive(socket.data.peerId, payload));
      },
      close(socket) {
        sockets.delete(socket.data.peerId);
        dispatch(core.disconnect(socket.data.peerId));
      },
      maxPayloadLength: config.maxMessageBytes,
    },
  });
  const sweepTimer = setInterval(
    () => dispatch(core.sweepExpiredRooms()),
    options.sweepIntervalMs ?? 1_000,
  );
  sweepTimer.unref();

  return {
    get url() {
      return bunServer.url;
    },
    stop(closeActiveConnections?: boolean) {
      clearInterval(sweepTimer);
      bunServer.stop(closeActiveConnections);
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
}
