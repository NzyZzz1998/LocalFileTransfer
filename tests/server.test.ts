import { afterEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { isLoopbackAddress, parseRelayEnabled, startServer, type ServerOptions } from "../src/server";

const runningServers: Array<ReturnType<typeof startServer>> = [];
const runningSockets: WebSocket[] = [];

function makeServer(options: ServerOptions = {}) {
  const server = startServer({ hostname: "127.0.0.1", port: 0, ...options });
  runningServers.push(server);
  return server;
}

afterEach(() => {
  for (const socket of runningSockets.splice(0)) {
    socket.close();
  }
  for (const server of runningServers.splice(0)) {
    server.stop(true);
  }
});

function webSocketUrl(server: ReturnType<typeof startServer>): URL {
  const url = new URL("/ws", server.url);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url;
}

function tryOpenWebSocket(
  server: ReturnType<typeof startServer>,
  origin = server.url.origin,
): Promise<{ opened: boolean; socket: WebSocket }> {
  const socket = new WebSocket(webSocketUrl(server), {
    headers: { Origin: origin },
  });
  runningSockets.push(socket);

  return new Promise((resolve) => {
    const finish = (opened: boolean) => resolve({ opened, socket });
    socket.addEventListener("open", () => finish(true), { once: true });
    socket.addEventListener("error", () => finish(false), { once: true });
    socket.addEventListener("close", () => finish(false), { once: true });
    setTimeout(() => finish(false), 1_000).unref();
  });
}

function nextJsonMessage(socket: WebSocket): Promise<unknown | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: unknown | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.removeEventListener("message", onMessage);
      socket.removeEventListener("close", onClose);
      resolve(value);
    };
    const onMessage = (event: MessageEvent) => {
      try {
        finish(JSON.parse(String(event.data)));
      } catch {
        finish(undefined);
      }
    };
    const onClose = () => finish(undefined);
    const timeout = setTimeout(() => finish(undefined), 1_000);
    timeout.unref();
    socket.addEventListener("message", onMessage, { once: true });
    socket.addEventListener("close", onClose, { once: true });
  });
}

function nextRawMessage(socket: WebSocket): Promise<unknown | undefined> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(undefined), 1_000);
    timeout.unref();
    socket.addEventListener("message", (event) => {
      clearTimeout(timeout);
      resolve(event.data);
    }, { once: true });
  });
}

async function pairedSignals(server: ReturnType<typeof startServer>) {
  const sender = (await tryOpenWebSocket(server)).socket;
  const receiver = (await tryOpenWebSocket(server)).socket;
  const created = nextJsonMessage(sender);
  sender.send(JSON.stringify({ type: "create_room" }));
  const code = (await created as { code: string }).code;
  const requested = nextJsonMessage(sender);
  const waiting = nextJsonMessage(receiver);
  receiver.send(JSON.stringify({ type: "join_room", code }));
  await Promise.all([requested, waiting]);
  const senderJoined = nextJsonMessage(sender);
  const receiverJoined = nextJsonMessage(receiver);
  sender.send(JSON.stringify({ type: "approve_join" }));
  await Promise.all([senderJoined, receiverJoined]);
  return { sender, receiver };
}

async function authorizeRelay(signals: { sender: WebSocket; receiver: WebSocket }) {
  const requested = nextJsonMessage(signals.receiver);
  signals.sender.send(JSON.stringify({ type: "request_relay" }));
  expect(await requested).toEqual({ type: "relay_requested" });
  const senderReady = nextJsonMessage(signals.sender);
  const receiverReady = nextJsonMessage(signals.receiver);
  signals.receiver.send(JSON.stringify({ type: "approve_relay" }));
  return await Promise.all([senderReady, receiverReady]) as Array<{ type: string; token: string; code?: string }>;
}

async function openRelay(server: ReturnType<typeof startServer>, token: string) {
  const url = new URL(`/relay?token=${encodeURIComponent(token)}`, server.url);
  url.protocol = "ws:";
  const socket = new WebSocket(url, { headers: { Origin: server.url.origin } });
  runningSockets.push(socket);
  // Install before open: the server may send relay_open in the same network turn.
  const relayOpened = nextJsonMessage(socket);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  return { socket, relayOpened };
}

function nextClose(socket: WebSocket): Promise<CloseEvent> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("relay did not close")), 1_000);
    socket.addEventListener("close", (event) => {
      clearTimeout(timeout);
      resolve(event);
    }, { once: true });
  });
}

function requestShutdown(server: ReturnType<typeof startServer>) {
  return fetch(new URL("/api/shutdown", server.url), {
    method: "POST",
    headers: { Origin: server.url.origin, "X-Dukou-Action": "shutdown" },
  });
}

async function expectShutdownMessage(message: Promise<unknown>) {
  const payload = await message as { type: string; requestId: string };
  expect(payload).toEqual({ type: "service_shutdown", requestId: expect.any(String) });
  expect(payload.requestId.length).toBeGreaterThan(0);
  return payload.requestId;
}

function acknowledgeShutdown(socket: WebSocket, requestId: string, status = "ready") {
  socket.send(JSON.stringify({ type: "shutdown_ack", requestId, status }));
}

describe("coordinated local shutdown", () => {
  test.serial("the command-line watcher exits after successful local shutdown", async () => {
    const child = Bun.spawn([process.execPath, "--watch", "src/server.ts"], {
      cwd: resolve(import.meta.dir, ".."),
      env: { ...process.env, HOST: "127.0.0.1", PORT: "0", RELAY_ENABLED: "0" },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const reader = child.stdout.getReader();
      const firstChunk = await Promise.race([
        reader.read(),
        Bun.sleep(2_000).then(() => { throw new Error("watcher did not report a URL"); }),
      ]);
      const output = new TextDecoder().decode(firstChunk.value);
      const urlText = output.match(/http:\/\/127\.0\.0\.1:\d+\//)?.[0];
      expect(urlText).toBeDefined();
      const url = new URL(urlText!);
      const response = await fetch(new URL("/api/shutdown", url), {
        method: "POST",
        headers: { Origin: url.origin, "X-Dukou-Action": "shutdown" },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      const exitCode = await Promise.race([child.exited, Bun.sleep(1_500).then(() => null)]);
      expect(exitCode).toBe(0);
      await expect(fetch(new URL("/healthz", url))).rejects.toThrow();
    } finally {
      if (child.exitCode === null) {
        if (process.platform === "win32") {
          // Only the exact watcher process created by this test and its children.
          Bun.spawnSync(["taskkill", "/PID", String(child.pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" });
        } else {
          child.kill();
        }
      }
      await child.exited;
    }
  }, 10_000);

  test("waits for every peer, rejects new transports, and accepts disconnect after ready", async () => {
    const server = makeServer({ shutdownTimeoutMs: 500 });
    const first = (await tryOpenWebSocket(server)).socket;
    const second = (await tryOpenWebSocket(server)).socket;
    const firstNotice = nextJsonMessage(first);
    const secondNotice = nextJsonMessage(second);
    let responded = false;
    const response = requestShutdown(server).then((value) => { responded = true; return value; });
    const requestId = await expectShutdownMessage(firstNotice);
    expect(await expectShutdownMessage(secondNotice)).toBe(requestId);
    acknowledgeShutdown(first, requestId);
    const firstClosed = nextClose(first);
    first.close();
    await firstClosed;

    for (const path of ["/ws", "/relay?token=unused"]) {
      const denied = await fetch(new URL(path, server.url), { headers: { Origin: server.url.origin } });
      expect(denied.status).toBe(503);
    }
    for (const path of ["/", "/healthz", "/api/runtime"]) {
      expect((await fetch(new URL(path, server.url))).status).toBe(200);
    }
    expect(responded).toBe(false);

    const secondClosed = nextClose(second);
    acknowledgeShutdown(second, requestId);
    const accepted = await response;
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ ok: true });
    expect((await fetch(new URL("/ws", server.url), { headers: { Origin: server.url.origin } })).status).toBe(503);
    await secondClosed;
    await expect(fetch(new URL("/healthz", server.url))).rejects.toThrow();
  });

  test("concurrent local shutdown requests share one broadcast and result", async () => {
    const server = makeServer({ shutdownTimeoutMs: 500 });
    const peer = (await tryOpenWebSocket(server)).socket;
    const broadcasts: unknown[] = [];
    peer.addEventListener("message", (event) => broadcasts.push(JSON.parse(String(event.data))));
    const notice = nextJsonMessage(peer);
    const requests = [requestShutdown(server), requestShutdown(server)];
    const requestId = await expectShutdownMessage(notice);
    await fetch(new URL("/healthz", server.url));
    acknowledgeShutdown(peer, requestId);
    acknowledgeShutdown(peer, requestId);
    const responses = await Promise.all(requests);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(await Promise.all(responses.map((response) => response.json()))).toEqual([{ ok: true }, { ok: true }]);
    expect(broadcasts).toEqual([{ type: "service_shutdown", requestId }]);
  });

  test.each([
    ["unsaved", "SHUTDOWN_UNSAVED_FILES"],
    ["cleanup_failed", "SHUTDOWN_CLEANUP_FAILED"],
  ])("%s blocks shutdown and permits a fresh successful retry", async (status, code) => {
    const server = makeServer({ shutdownTimeoutMs: 500 });
    const first = (await tryOpenWebSocket(server)).socket;
    const second = (await tryOpenWebSocket(server)).socket;
    const firstNotice = nextJsonMessage(first);
    const secondNotice = nextJsonMessage(second);
    const response = requestShutdown(server);
    const requestId = await expectShutdownMessage(firstNotice);
    await expectShutdownMessage(secondNotice);
    acknowledgeShutdown(first, requestId);
    acknowledgeShutdown(second, requestId, status);
    const blocked = await response;
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toEqual({ ok: false, code });
    expect((await fetch(new URL("/healthz", server.url))).status).toBe(200);
    expect((await fetch(new URL("/ws", server.url), { headers: { Origin: server.url.origin } })).status).toBe(426);

    const retryFirst = nextJsonMessage(first);
    const retrySecond = nextJsonMessage(second);
    const retry = requestShutdown(server);
    const retryId = await expectShutdownMessage(retryFirst);
    expect(retryId).not.toBe(requestId);
    expect(await expectShutdownMessage(retrySecond)).toBe(retryId);
    acknowledgeShutdown(first, retryId);
    acknowledgeShutdown(second, retryId);
    expect(await (await retry).json()).toEqual({ ok: true });
  });

  test("stale and malformed acknowledgements cannot satisfy the bounded cleanup wait", async () => {
    const server = makeServer({ shutdownTimeoutMs: 100 });
    const peer = (await tryOpenWebSocket(server)).socket;
    const notice = nextJsonMessage(peer);
    const response = requestShutdown(server);
    const requestId = await expectShutdownMessage(notice);
    acknowledgeShutdown(peer, "stale-request-id");
    acknowledgeShutdown(peer, requestId, "complete");
    peer.send(JSON.stringify({ type: "shutdown_ack", requestId, status: "ready", unexpected: true }));
    const blocked = await response;
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toEqual({ ok: false, code: "SHUTDOWN_CLIENT_UNRESPONSIVE" });
    expect((await fetch(new URL("/healthz", server.url))).status).toBe(200);

    const retryNotice = nextJsonMessage(peer);
    const retry = requestShutdown(server);
    const retryId = await expectShutdownMessage(retryNotice);
    acknowledgeShutdown(peer, requestId);
    acknowledgeShutdown(peer, retryId);
    expect(await (await retry).json()).toEqual({ ok: true });
  });

  test("a peer closing before acknowledgement blocks shutdown", async () => {
    const server = makeServer({ shutdownTimeoutMs: 500 });
    const peer = (await tryOpenWebSocket(server)).socket;
    const notice = nextJsonMessage(peer);
    const response = requestShutdown(server);
    await expectShutdownMessage(notice);
    peer.close();
    const blocked = await response;
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toEqual({ ok: false, code: "SHUTDOWN_CLIENT_UNRESPONSIVE" });
    expect((await fetch(new URL("/healthz", server.url))).status).toBe(200);
  });

  test.each(["oversized", "binary"])("%s shutdown acknowledgements retain signaling payload protections", async (kind) => {
    const server = makeServer({
      shutdownTimeoutMs: 500,
      signalingConfig: { roomTtlMs: 600_000, maxMessageBytes: 128, joinRateLimit: { maxAttempts: 5, windowMs: 60_000 } },
    });
    const peer = (await tryOpenWebSocket(server)).socket;
    const notice = nextJsonMessage(peer);
    const response = requestShutdown(server);
    const requestId = await expectShutdownMessage(notice);
    const closed = nextClose(peer);
    const payload = JSON.stringify({ type: "shutdown_ack", requestId: kind === "oversized" ? "x".repeat(200) : requestId, status: "ready" });
    peer.send(kind === "binary" ? new TextEncoder().encode(payload) : payload);
    expect((await closed).code).toBe(kind === "binary" ? 1003 : 1009);
    expect(await (await response).json()).toEqual({ ok: false, code: "SHUTDOWN_CLIENT_UNRESPONSIVE" });
  });

  test("unauthorized HTTP and client signaling commands cannot initiate shutdown", async () => {
    const server = makeServer();
    const peer = (await tryOpenWebSocket(server)).socket;
    for (const init of [
      { method: "GET", headers: { Origin: server.url.origin, "X-Dukou-Action": "shutdown" } },
      { method: "POST", headers: { Origin: "https://evil.example", "X-Dukou-Action": "shutdown" } },
      { method: "POST", headers: { Origin: server.url.origin } },
      { method: "POST", headers: { "X-Dukou-Action": "shutdown" } },
    ]) {
      expect((await fetch(new URL("/api/shutdown", server.url), init)).status).toBe(403);
    }
    const reply = nextJsonMessage(peer);
    peer.send(JSON.stringify({ type: "service_shutdown", requestId: "remote-attempt" }));
    expect(await reply).toMatchObject({ type: "error", code: "INVALID_MESSAGE" });
    expect((await fetch(new URL("/healthz", server.url))).status).toBe(200);
  });

  test("successful cleanup acknowledgement closes active signaling and relay sockets", async () => {
    const server = makeServer({ shutdownTimeoutMs: 500 });
    const signals = await pairedSignals(server);
    const tokens = await authorizeRelay(signals);
    const senderRelay = await openRelay(server, tokens[0]!.token);
    const receiverRelay = await openRelay(server, tokens[1]!.token);
    await Promise.all([senderRelay.relayOpened, receiverRelay.relayOpened]);
    const notices = [nextJsonMessage(signals.sender), nextJsonMessage(signals.receiver)];
    const response = requestShutdown(server);
    const requestId = await expectShutdownMessage(notices[0]!);
    expect(await expectShutdownMessage(notices[1]!)).toBe(requestId);
    const closed = [signals.sender, signals.receiver, senderRelay.socket, receiverRelay.socket].map(nextClose);
    acknowledgeShutdown(signals.sender, requestId);
    acknowledgeShutdown(signals.receiver, requestId);
    expect(await (await response).json()).toEqual({ ok: true });
    await Promise.all(closed);
    await expect(fetch(new URL("/healthz", server.url))).rejects.toThrow();
  });
});

describe("Bun HTTP/WebSocket server", () => {
  test("accepts only explicit boolean relay flag values", () => {
    expect(parseRelayEnabled(undefined)).toBe(true);
    expect(parseRelayEnabled("true")).toBe(true);
    expect(parseRelayEnabled("1")).toBe(true);
    expect(parseRelayEnabled("false")).toBe(false);
    expect(parseRelayEnabled("0")).toBe(false);
    expect(() => parseRelayEnabled("offf")).toThrow("RELAY_ENABLED");
  });

  test("disabled relay is advertised and rejected while direct signaling remains available", async () => {
    const server = makeServer({ relayEnabled: false });
    const runtime = await (await fetch(new URL("/api/runtime", server.url))).json();
    expect(runtime.relayEnabled).toBe(false);
    const endpoint = await fetch(new URL("/relay?token=unused", server.url), {
      headers: { Origin: server.url.origin },
    });
    expect(endpoint.status).toBe(503);
    expect(await endpoint.text()).toBe("RELAY_DISABLED");
    const { sender, receiver } = await pairedSignals(server);
    const rejected = nextJsonMessage(sender);
    sender.send(JSON.stringify({ type: "request_relay" }));
    expect(await rejected).toMatchObject({ type: "error", code: "RELAY_DISABLED" });
    const forwarded = nextJsonMessage(receiver);
    sender.send(JSON.stringify({ type: "signal", signal: { type: "offer", sdp: "direct-still-works" } }));
    expect(await forwarded).toMatchObject({ type: "signal", signal: { sdp: "direct-still-works" } });
  });
  test("recognizes loopback shutdown callers without trusting LAN or mapped remote addresses", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("192.168.31.45")).toBe(false);
    expect(isLoopbackAddress("::ffff:192.168.31.45")).toBe(false);
  });
  test.serial("starts from the command line and reports its actual URL", async () => {
    const child = Bun.spawn([process.execPath, "src/server.ts"], {
      cwd: resolve(import.meta.dir, ".."),
      env: { ...process.env, HOST: "127.0.0.1", PORT: "0", RELAY_ENABLED: "0" },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const reader = child.stdout.getReader();
      const firstChunk = await Promise.race([
        reader.read(),
        Bun.sleep(2_000).then(() => {
          throw new Error("server did not report a URL");
        }),
      ]);
      const output = new TextDecoder().decode(firstChunk.value);
      const urlText = output.match(/http:\/\/127\.0\.0\.1:\d+\//)?.[0];
      expect(urlText).toBeDefined();
      const response = await fetch(new URL("/healthz", urlText));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      const runtime = await (await fetch(new URL("/api/runtime", urlText))).json();
      expect(runtime.relayEnabled).toBe(false);
    } finally {
      child.kill();
      await child.exited;
    }
  });

  test("serves the homepage and its same-origin static resources", async () => {
    const server = makeServer();

    const home = await fetch(new URL("/", server.url));
    const css = await fetch(new URL("/app.css", server.url));
    const script = await fetch(new URL("/app.js", server.url));

    expect(home.status).toBe(200);
    expect(home.headers.get("content-type")).toStartWith("text/html");
    expect(await home.text()).toContain("渡口");
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toStartWith("text/css");
    expect(await css.text()).toContain(":root");
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toStartWith("text/javascript");
    expect(await script.text()).toContain("choose-sender");
  });

  test("serves the browser WebRTC, transfer, and storage modules", async () => {
    const server = makeServer();

    for (const pathname of ["/peer-session.js", "/transfer.js", "/storage.js"]) {
      const response = await fetch(new URL(pathname, server.url));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toStartWith("text/javascript");
      expect(await response.text()).toContain("export");
    }
  });

  test("answers the browser favicon request without a 404", async () => {
    const server = makeServer();

    const response = await fetch(new URL("/favicon.ico", server.url));

    expect(response.status).toBe(204);
  });

  test("returns a minimal JSON health response", async () => {
    const server = makeServer();

    const response = await fetch(new URL("/healthz", server.url));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toStartWith("application/json");
    expect(await response.json()).toEqual({ ok: true });
  });

  test("returns sanitized runtime information with the actual bound port", async () => {
    const server = startServer({
      hostname: "127.0.0.1",
      port: 0,
      networkInterfaces: () => ({
        "JiuX TUN": [
          {
            address: "198.18.0.1",
            netmask: "255.255.255.0",
            family: "IPv4",
            mac: "00:00:00:00:00:00",
            internal: false,
            cidr: "198.18.0.1/24",
          },
        ],
        WiFi: [
          {
            address: "192.168.31.73",
            netmask: "255.255.255.0",
            family: "IPv4",
            mac: "00:00:00:00:00:00",
            internal: false,
            cidr: "192.168.31.73/24",
          },
        ],
      }),
    });
    runningServers.push(server);

    const response = await fetch(new URL("/api/runtime", server.url));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      version: "0.2.0",
      port: server.url.port ? Number(server.url.port) : 80,
      lanUrls: [
        `http://192.168.31.73:${server.url.port}`,
        `http://198.18.0.1:${server.url.port}`,
      ],
      recommendedUrl: `http://192.168.31.73:${server.url.port}`,
      canShutdown: true,
      relayEnabled: true,
    });

    const removedQr = await fetch(new URL("/api/runtime/qr", server.url));
    expect(removedQr.status).toBe(404);
  });

  test("requires a loopback same-origin action request before shutting down", async () => {
    const server = startServer({ hostname: "127.0.0.1", port: 0 });
    runningServers.push(server);
    const denied = await fetch(new URL("/api/shutdown", server.url), { method: "POST" });
    expect(denied.status).toBe(403);

    const accepted = await fetch(new URL("/api/shutdown", server.url), {
      method: "POST",
      headers: {
        Origin: server.url.origin,
        "X-Dukou-Action": "shutdown",
      },
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ ok: true });
    await Bun.sleep(100);
    await expect(fetch(new URL("/healthz", server.url))).rejects.toThrow();
  });

  test("adds the security policy headers to successful and error responses", async () => {
    const server = makeServer();

    for (const pathname of ["/", "/healthz", "/missing"]) {
      const response = await fetch(new URL(pathname, server.url));
      const csp = response.headers.get("content-security-policy") ?? "";

      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("object-src 'none'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("permissions-policy")).toBe(
        "camera=(), microphone=(), geolocation=()",
      );
    }
  });

  test("does not expose a file upload HTTP endpoint", async () => {
    const server = makeServer();

    for (const pathname of ["/upload", "/api/upload", "/files"]) {
      const upload = await fetch(new URL(pathname, server.url), {
        method: "POST",
        body: "must-not-be-stored",
      });

      expect(upload.status).toBe(405);
      expect(upload.headers.get("allow")).toBe("GET");

      const lookup = await fetch(new URL(pathname, server.url));
      expect(lookup.status).toBe(404);
      expect(await lookup.text()).not.toContain("must-not-be-stored");
    }
  });

  test("accepts a same-origin websocket upgrade at /ws", async () => {
    const server = makeServer();

    const connection = await tryOpenWebSocket(server);

    expect(connection.opened).toBe(true);
    expect(connection.socket.readyState).toBe(WebSocket.OPEN);
  });

  test("rejects a cross-origin websocket upgrade", async () => {
    const server = makeServer();

    const connection = await tryOpenWebSocket(server, "https://evil.example");

    expect(connection.opened).toBe(false);
    expect(connection.socket.readyState).not.toBe(WebSocket.OPEN);
  });

  test("rejects websocket upgrades after the configured peer capacity is full", async () => {
    const server = startServer({
      hostname: "127.0.0.1",
      port: 0,
      signalingConfig: {
        roomTtlMs: 600_000,
        maxMessageBytes: 65_536,
        joinRateLimit: { maxAttempts: 5, windowMs: 60_000 },
        limits: { maxPeers: 1, maxPeersPerClient: 1 },
      },
    });
    runningServers.push(server);

    const first = await tryOpenWebSocket(server);
    const overCapacity = await tryOpenWebSocket(server);

    expect(first.opened).toBe(true);
    expect(overCapacity.opened).toBe(false);
    expect(first.socket.readyState).toBe(WebSocket.OPEN);
  });

  test("relays signaling across two real websocket clients after sender approval", async () => {
    const server = makeServer();
    const sender = (await tryOpenWebSocket(server)).socket;
    const receiver = (await tryOpenWebSocket(server)).socket;

    const createdMessage = nextJsonMessage(sender);
    sender.send(JSON.stringify({ type: "create_room" }));
    const created = await createdMessage;
    expect(created).toBeDefined();
    const createdPayload = created as {
      type: string;
      code: string;
      expiresAt: unknown;
    };
    const roomCode = createdPayload.code;
    expect(createdPayload.type).toBe("room_created");
    expect(roomCode).toMatch(/^\d{6}$/);
    expect(typeof createdPayload.expiresAt).toBe("number");

    const joinRequestedMessage = nextJsonMessage(sender);
    const joinWaitingMessage = nextJsonMessage(receiver);
    receiver.send(JSON.stringify({ type: "join_room", code: roomCode }));
    expect(await joinRequestedMessage).toEqual({ type: "join_requested" });
    expect(await joinWaitingMessage).toMatchObject({
      type: "join_waiting",
      expiresAt: expect.any(Number),
    });

    const senderJoinedMessage = nextJsonMessage(sender);
    const receiverJoinedMessage = nextJsonMessage(receiver);
    sender.send(JSON.stringify({ type: "approve_join" }));
    expect(await senderJoinedMessage).toEqual({ type: "peer_joined", role: "sender" });
    expect(await receiverJoinedMessage).toEqual({
      type: "peer_joined",
      role: "receiver",
    });

    const relayedSignalMessage = nextJsonMessage(receiver);
    sender.send(
      JSON.stringify({
        type: "signal",
        signal: { type: "offer", sdp: "sender-sdp" },
      }),
    );
    expect(await relayedSignalMessage).toEqual({
      type: "signal",
      signal: { type: "offer", sdp: "sender-sdp" },
    });
  });

  test("opens an explicit one-time relay and forwards opaque binary frames", async () => {
    const server = makeServer();
    const sender = (await tryOpenWebSocket(server)).socket;
    const receiver = (await tryOpenWebSocket(server)).socket;
    const createdPromise = nextJsonMessage(sender);
    sender.send(JSON.stringify({ type: "create_room" }));
    const code = (await createdPromise as any).code;
    const request = nextJsonMessage(sender);
    const waiting = nextJsonMessage(receiver);
    receiver.send(JSON.stringify({ type: "join_room", code }));
    await Promise.all([request, waiting]);
    const senderJoined = nextJsonMessage(sender);
    const receiverJoined = nextJsonMessage(receiver);
    sender.send(JSON.stringify({ type: "approve_join" }));
    await Promise.all([senderJoined, receiverJoined]);
    const relayRequested = nextJsonMessage(receiver);
    sender.send(JSON.stringify({ type: "request_relay" }));
    expect(await relayRequested).toEqual({ type: "relay_requested" });
    const senderReady = nextJsonMessage(sender);
    const receiverReady = nextJsonMessage(receiver);
    receiver.send(JSON.stringify({ type: "approve_relay" }));
    const [senderCredential, receiverCredential] = await Promise.all([senderReady, receiverReady]) as any[];

    const openRelay = async (token: string) => {
      const url = new URL(`/relay?token=${encodeURIComponent(token)}`, server.url);
      url.protocol = "ws:";
      const socket = new WebSocket(url, { headers: { Origin: server.url.origin } });
      runningSockets.push(socket);
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", reject, { once: true });
      });
      return socket;
    };
    const senderRelay = await openRelay(senderCredential.token);
    const senderOpened = nextJsonMessage(senderRelay);
    const receiverRelay = await openRelay(receiverCredential.token);
    const receiverOpened = nextJsonMessage(receiverRelay);
    expect(await senderOpened).toEqual({ type: "relay_open" });
    expect(await receiverOpened).toEqual({ type: "relay_open" });
    const delivered = nextRawMessage(receiverRelay);
    senderRelay.send(Uint8Array.from([7, 8, 9]));
    expect(new Uint8Array(await delivered as ArrayBuffer)).toEqual(Uint8Array.from([7, 8, 9]));
  });

  test("actively expires an idle room and releases its sender", async () => {
    let now = 1_000;
    const server = startServer({
      hostname: "127.0.0.1",
      port: 0,
      signalingConfig: {
        roomTtlMs: 10,
        maxMessageBytes: 65_536,
        joinRateLimit: { maxAttempts: 5, windowMs: 60_000 },
      },
      now: () => now,
      nextRoomCode: () => "583204",
      sweepIntervalMs: 5,
    });
    runningServers.push(server);
    const sender = (await tryOpenWebSocket(server)).socket;
    const createdMessage = nextJsonMessage(sender);
    sender.send(JSON.stringify({ type: "create_room" }));
    expect(await createdMessage).toMatchObject({ type: "room_created", code: "583204" });

    const expiredMessage = nextJsonMessage(sender);
    now = 1_010;
    expect(await expiredMessage).toEqual({ type: "room_expired" });

    const replacementMessage = nextJsonMessage(sender);
    sender.send(JSON.stringify({ type: "create_room" }));
    expect(await replacementMessage).toMatchObject({
      type: "room_created",
      code: "583204",
    });
  });

  test("leaving revokes issued tokens and closes both active relay sockets", async () => {
    const server = makeServer();
    const signals = await pairedSignals(server);
    const tokens = await authorizeRelay(signals);
    const left = nextJsonMessage(signals.receiver);
    signals.sender.send(JSON.stringify({ type: "leave" }));
    expect(await left).toEqual({ type: "peer_left" });
    const invalid = await fetch(new URL(`/relay?token=${tokens[0]!.token}`, server.url), {
      headers: { Origin: server.url.origin },
    });
    expect(invalid.status).toBe(403);

    const activeSignals = await pairedSignals(server);
    const activeTokens = await authorizeRelay(activeSignals);
    const senderRelay = await openRelay(server, activeTokens[0]!.token);
    const receiverRelay = await openRelay(server, activeTokens[1]!.token);
    await Promise.all([senderRelay.relayOpened, receiverRelay.relayOpened]);
    const senderClosed = nextClose(senderRelay.socket);
    const receiverClosed = nextClose(receiverRelay.socket);
    activeSignals.sender.close();
    expect((await senderClosed).reason).toBe("RELAY_CLOSED");
    expect((await receiverClosed).reason).toBe("RELAY_CLOSED");
  });

  test("an orphan relay times out and a full relay expires when idle", async () => {
    let now = 1_000;
    const server = makeServer({
      now: () => now, sweepIntervalMs: 5,
      relayConfig: { handshakeTimeoutMs: 10, idleTimeoutMs: 20, maxSessions: 1 },
    });
    const orphanSignals = await pairedSignals(server);
    const orphanTokens = await authorizeRelay(orphanSignals);
    const orphan = await openRelay(server, orphanTokens[0]!.token);
    const orphanClosed = nextClose(orphan.socket);
    now = 1_010;
    expect((await orphanClosed).reason).toBe("RELAY_TIMEOUT");
    const invalid = await fetch(new URL(`/relay?token=${orphanTokens[1]!.token}`, server.url), {
      headers: { Origin: server.url.origin },
    });
    expect(invalid.status).toBe(403);

    const signals = await pairedSignals(server);
    const tokens = await authorizeRelay(signals);
    const sender = await openRelay(server, tokens[0]!.token);
    const receiver = await openRelay(server, tokens[1]!.token);
    await Promise.all([sender.relayOpened, receiver.relayOpened]);
    const senderClosed = nextClose(sender.socket);
    const receiverClosed = nextClose(receiver.socket);
    now = 1_030;
    expect((await senderClosed).reason).toBe("RELAY_TIMEOUT");
    expect((await receiverClosed).reason).toBe("RELAY_TIMEOUT");
  });

  test("capacity failures send errors to both peers without issuing relay_ready", async () => {
    const server = makeServer({ relayConfig: { maxSessionsPerClient: 1 } });
    await authorizeRelay(await pairedSignals(server));
    const rejected = await authorizeRelay(await pairedSignals(server));
    expect(rejected).toMatchObject([
      { type: "error", code: "RELAY_LIMIT" },
      { type: "error", code: "RELAY_LIMIT" },
    ]);
    expect(rejected.every((message) => !("token" in message))).toBe(true);
  });

  test("oversized relay frames close both sides with the same explicit error", async () => {
    const server = makeServer({ relayConfig: { maxFrameBytes: 4 } });
    const tokens = await authorizeRelay(await pairedSignals(server));
    const sender = await openRelay(server, tokens[0]!.token);
    const receiver = await openRelay(server, tokens[1]!.token);
    await Promise.all([sender.relayOpened, receiver.relayOpened]);
    const senderClosed = nextClose(sender.socket);
    const receiverClosed = nextClose(receiver.socket);
    sender.socket.send(new Uint8Array(5));
    expect((await senderClosed).reason).toBe("RELAY_LIMIT");
    expect((await receiverClosed).reason).toBe("RELAY_LIMIT");
  });
});
