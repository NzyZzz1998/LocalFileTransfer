import { afterEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { startServer } from "../src/server";

const runningServers: Array<ReturnType<typeof startServer>> = [];
const runningSockets: WebSocket[] = [];

function makeServer() {
  const server = startServer({ hostname: "127.0.0.1", port: 0 });
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

describe("Bun HTTP/WebSocket server", () => {
  test.serial("starts from the command line and reports its actual URL", async () => {
    const child = Bun.spawn([process.execPath, "src/server.ts"], {
      cwd: resolve(import.meta.dir, ".."),
      env: { ...process.env, HOST: "127.0.0.1", PORT: "0" },
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
});
