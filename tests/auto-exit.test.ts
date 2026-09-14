import { afterEach, describe, expect, test } from "bun:test";
import { networkInterfaces } from "node:os";
import { startServer, type ServerOptions } from "../src/server";

const servers: Array<ReturnType<typeof startServer>> = [];
const sockets: WebSocket[] = [];
const delay = 60;

function makeServer(options: ServerOptions = {}) {
  const server = startServer({ hostname: "127.0.0.1", port: 0, autoShutdownDelayMs: delay, shutdownTimeoutMs: 100, ...options });
  servers.push(server);
  return server;
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true);
  for (const socket of sockets.splice(0)) socket.close();
});

function nextMessage(socket: WebSocket, timeoutMs = 500): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve) => {
    const finish = (value?: Record<string, unknown>) => {
      clearTimeout(timer);
      socket.removeEventListener("message", onMessage);
      resolve(value);
    };
    const onMessage = (event: MessageEvent) => finish(JSON.parse(String(event.data)));
    const timer = setTimeout(() => finish(), timeoutMs);
    socket.addEventListener("message", onMessage, { once: true });
  });
}

async function openSocket(server: ReturnType<typeof startServer>, path = "/ws") {
  const url = new URL(path, server.url);
  url.protocol = "ws:";
  const socket = new WebSocket(url, { headers: { Origin: server.url.origin } });
  sockets.push(socket);
  const greeting = path === "/local-manager" ? nextMessage(socket) : undefined;
  const opened = await new Promise<boolean>((resolve) => {
    socket.addEventListener("open", () => resolve(true), { once: true });
    socket.addEventListener("error", () => resolve(false), { once: true });
  });
  expect(opened).toBe(true);
  if (greeting) expect(await greeting).toEqual({ type: "manager_ready" });
  return socket;
}

async function closeSocket(socket: WebSocket) {
  if (socket.readyState === WebSocket.CLOSED) return;
  const closed = new Promise<void>((resolve) => socket.addEventListener("close", () => resolve(), { once: true }));
  socket.close();
  await closed;
}

function ack(socket: WebSocket, requestId: unknown, status = "ready") {
  socket.send(JSON.stringify({ type: "shutdown_ack", requestId, status }));
}

function retry(socket: WebSocket, requestId: unknown) {
  socket.send(JSON.stringify({ type: "shutdown_retry", requestId }));
}

async function expectLive(server: ReturnType<typeof startServer>) {
  expect((await fetch(new URL("/healthz", server.url))).status).toBe(200);
}

async function expectStopped(server: ReturnType<typeof startServer>) {
  await Bun.sleep(100);
  await expect(fetch(new URL("/healthz", server.url))).rejects.toThrow();
}

async function startAutoAttempt(server: ReturnType<typeof startServer>, peer: WebSocket) {
  const manager = await openSocket(server, "/local-manager");
  const notice = nextMessage(peer);
  await closeSocket(manager);
  const message = await notice;
  expect(message).toEqual({ type: "service_shutdown", requestId: expect.any(String), automatic: true });
  return message!.requestId;
}

describe("last local management page auto exit", () => {
  // Catches a missing manager endpoint or a lost last-owner disconnect side effect.
  test("the last local page closes the listener after a reconnect grace", async () => {
    const server = makeServer();
    const manager = await openSocket(server, "/local-manager");
    await closeSocket(manager);
    await expectLive(server);
    await Bun.sleep(delay);
    await expectStopped(server);
  });

  test("startup without a management page never arms automatic exit", async () => {
    const server = makeServer();
    await Bun.sleep(delay + 120);
    await expectLive(server);
  });

  test("closing only a transfer socket never arms automatic exit", async () => {
    const server = makeServer();
    await closeSocket(await openSocket(server));
    await Bun.sleep(delay + 120);
    await expectLive(server);
  });

  test("another management tab keeps the server alive", async () => {
    const server = makeServer();
    const first = await openSocket(server, "/local-manager");
    const second = await openSocket(server, "/local-manager");
    await closeSocket(first);
    await Bun.sleep(delay + 120);
    await expectLive(server);
    await closeSocket(second);
    await Bun.sleep(delay);
    await expectStopped(server);
  });

  test("refresh reconnect cancels the old grace and a later close can exit", async () => {
    const server = makeServer();
    await closeSocket(await openSocket(server, "/local-manager"));
    const replacement = await openSocket(server, "/local-manager");
    await Bun.sleep(delay + 120);
    await expectLive(server);
    await closeSocket(replacement);
    await Bun.sleep(delay);
    await expectStopped(server);
  });

  test.each([undefined, "https://evil.example", "null"])("untrusted manager origin %s cannot arm shutdown", async (origin) => {
    const server = makeServer();
    const headers: Record<string, string> = origin ? { Origin: origin } : {};
    const response = await fetch(new URL("/local-manager", server.url), { headers });
    expect(response.status).toBe(403);
    await Bun.sleep(delay + 100);
    await expectLive(server);
  });

  test("an ordinary authorized GET does not count as an opened management page", async () => {
    const server = makeServer();
    const response = await fetch(new URL("/local-manager", server.url), { headers: { Origin: server.url.origin } });
    expect(response.status).toBe(426);
    await Bun.sleep(delay + 100);
    await expectLive(server);
  });

  const lanAddress = Object.values(networkInterfaces()).flat().find((entry) => entry?.family === "IPv4" && !entry.internal)?.address;
  test.skipIf(!lanAddress)("LAN callers cannot gain manager authority through forwarded loopback headers", async () => {
    const server = makeServer({ hostname: "0.0.0.0" });
    const url = new URL(`http://${lanAddress}:${server.url.port}/local-manager`);
    const response = await fetch(url, { headers: { Origin: url.origin, "X-Forwarded-For": "127.0.0.1", "X-Real-IP": "127.0.0.1" } });
    expect(response.status).toBe(403);
    await Bun.sleep(delay + 100);
    expect((await fetch(new URL("/healthz", url))).status).toBe(200);
  });

  test.each(["unsaved", "cleanup_failed"])("%s blocks automatic exit until that peer explicitly retries", async (status) => {
    const server = makeServer();
    const peer = await openSocket(server);
    const requestId = await startAutoAttempt(server, peer);
    ack(peer, requestId, status);
    expect(await nextMessage(peer, 160)).toBeUndefined();
    await expectLive(server);
    const next = nextMessage(peer);
    retry(peer, requestId);
    const retried = await next;
    expect(retried).toMatchObject({ type: "service_shutdown", automatic: true });
    expect(retried!.requestId).not.toBe(requestId);
    ack(peer, retried!.requestId);
    await expectStopped(server);
  });

  test("save retry while another peer is still cleaning is not lost", async () => {
    const server = makeServer({ shutdownTimeoutMs: 500 });
    const savedPeer = await openSocket(server);
    const cleaningPeer = await openSocket(server);
    const cleaningNotice = nextMessage(cleaningPeer);
    const requestId = await startAutoAttempt(server, savedPeer);
    expect((await cleaningNotice)!.requestId).toBe(requestId);
    ack(savedPeer, requestId, "unsaved");
    retry(savedPeer, requestId);
    const savedRetry = nextMessage(savedPeer);
    const cleaningRetry = nextMessage(cleaningPeer);
    ack(cleaningPeer, requestId);
    const next = await savedRetry;
    expect(next).toMatchObject({ type: "service_shutdown", automatic: true });
    expect((await cleaningRetry)!.requestId).toBe(next!.requestId);
    ack(savedPeer, next!.requestId);
    ack(cleaningPeer, next!.requestId);
    await expectStopped(server);
  });

  test("stale, outsider, ready-peer and malformed retries cannot authorize exit", async () => {
    const server = makeServer();
    const blocker = await openSocket(server);
    const readyPeer = await openSocket(server);
    const readyNotice = nextMessage(readyPeer);
    const requestId = await startAutoAttempt(server, blocker);
    await readyNotice;
    ack(blocker, requestId, "unsaved");
    ack(readyPeer, requestId);
    await expectLive(server);
    const outsider = await openSocket(server);
    retry(outsider, requestId);
    retry(readyPeer, requestId);
    retry(blocker, "stale");
    blocker.send(JSON.stringify({ type: "shutdown_retry", requestId, extra: true }));
    expect(await nextMessage(blocker, 160)).toBeUndefined();
    await expectLive(server);
    const notice = nextMessage(blocker);
    retry(blocker, requestId);
    expect(await notice).toMatchObject({ type: "service_shutdown", automatic: true });
  });

  test("retry without a prior management close never arms automatic exit", async () => {
    const server = makeServer();
    const peer = await openSocket(server);
    retry(peer, "invented");
    expect(await nextMessage(peer, delay + 120)).toBeUndefined();
    await expectLive(server);
  });

  test("unresponsive clients fail safe without automatic polling retries", async () => {
    const server = makeServer({ shutdownTimeoutMs: 50 });
    const peer = await openSocket(server);
    await startAutoAttempt(server, peer);
    expect(await nextMessage(peer, 160)).toBeUndefined();
    await expectLive(server);
  });

  test("reopening a local page cancels an in-flight auto attempt and its admission gate", async () => {
    const server = makeServer({ shutdownTimeoutMs: 500 });
    const peer = await openSocket(server);
    const requestId = await startAutoAttempt(server, peer);
    const cancelled = nextMessage(peer);
    await openSocket(server, "/local-manager");
    expect(await cancelled).toEqual({ type: "service_shutdown_cancelled", requestId });
    ack(peer, requestId);
    await openSocket(server);
    await Bun.sleep(160);
    await expectLive(server);
  });

  test("reopening a local page cancels a blocked retry capability", async () => {
    const server = makeServer();
    const peer = await openSocket(server);
    const requestId = await startAutoAttempt(server, peer);
    ack(peer, requestId, "unsaved");
    await expectLive(server);
    const cancelled = nextMessage(peer);
    await openSocket(server, "/local-manager");
    expect(await cancelled).toEqual({ type: "service_shutdown_cancelled", requestId });
    retry(peer, requestId);
    expect(await nextMessage(peer, 160)).toBeUndefined();
    await expectLive(server);
  });

  test("reopening during the final stop grace cancels pre-commit automatic exit", async () => {
    const server = makeServer();
    const peer = await openSocket(server);
    const requestId = await startAutoAttempt(server, peer);
    ack(peer, requestId);
    await expectLive(server);
    await openSocket(server, "/local-manager");
    await Bun.sleep(160);
    await expectLive(server);
  });

  test("explicit manual shutdown is not cancelled by a local page reconnect", async () => {
    const server = makeServer({ shutdownTimeoutMs: 500 });
    const peer = await openSocket(server);
    const requestId = await startAutoAttempt(server, peer);
    const response = fetch(new URL("/api/shutdown", server.url), {
      method: "POST", headers: { Origin: server.url.origin, "X-Dukou-Action": "shutdown" },
    });
    // An HTTP round-trip ensures manual intent has reached the server before reconnect.
    await expectLive(server);
    const denied = await fetch(new URL("/local-manager", server.url), { headers: { Origin: server.url.origin } });
    expect(denied.status).toBe(503);
    ack(peer, requestId);
    expect(await (await response).json()).toEqual({ ok: true });
    await expectStopped(server);
  });

  test("an explicit server stop cancels the pending last-page timer", async () => {
    let callbacks = 0;
    const server = makeServer({ onShutdownComplete: () => { callbacks++; } });
    await closeSocket(await openSocket(server, "/local-manager"));
    await server.stop(true);
    await Bun.sleep(delay + 120);
    expect(callbacks).toBe(0);
  });
});
