/** Execute a native artifact outside the checkout and verify its embedded release. */
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

interface SmokeOptions {
  binaryPath: string;
  sourceRoot?: string;
  expectedVersion?: string;
  timeoutMs?: number;
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function deadline<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

export async function smokeBinary(options: SmokeOptions) {
  const sourceRoot = resolve(options.sourceRoot ?? join(import.meta.dir, ".."));
  const binaryPath = resolve(options.binaryPath);
  const expectedVersion = options.expectedVersion ?? (await Bun.file(join(sourceRoot, "package.json")).json()).version;
  const timeoutMs = options.timeoutMs ?? 15_000;
  check(await Bun.file(binaryPath).exists(), `Native artifact is missing: ${binaryPath}`);
  const cwd = await mkdtemp(join(tmpdir(), "dukou-artifact-smoke-"));
  const report = {
    ok: false, binaryPath, cwd, version: "", baseUrl: "", assetCount: 0,
    sha256: "", pid: 0, exitCode: null as number | null, forcedCleanup: false,
    shutdownUnauthorizedStatus: 0, shutdownStatus: 0,
  };
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let failure: Error | undefined;
  let stderr = "";
  let readOutput: Promise<void> | undefined;
  let readErrors: Promise<void> | undefined;
  try {
    child = Bun.spawn([binaryPath], {
      cwd,
      env: { ...process.env, HOST: "127.0.0.1", PORT: "0", RELAY_ENABLED: "1" },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    report.pid = child.pid;
    let output = "";
    let resolveReady: (url: string) => void;
    const ready = new Promise<string>((resolveUrl) => { resolveReady = resolveUrl; });
    readOutput = (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of child!.stdout) {
        output += decoder.decode(chunk, { stream: true });
        const url = output.match(/http:\/\/127\.0\.0\.1:\d+\//)?.[0];
        if (url) resolveReady!(url);
      }
    })();
    readErrors = new Response(child.stderr).text().then((text) => { stderr = text; });
    report.baseUrl = await deadline(Promise.race([
      ready,
      child.exited.then((code) => { throw new Error(`Native artifact exited before ready (code ${code})`); }),
    ]), timeoutMs, "Native artifact did not become ready");
    const baseUrl = new URL(report.baseUrl);
    check(Number(baseUrl.port) > 0, "Native artifact did not receive an ephemeral port");
    const request = (route: string, init?: RequestInit) => fetch(new URL(route, baseUrl), {
      ...init, signal: AbortSignal.timeout(timeoutMs),
    });
    const health = await request("/healthz");
    check(health.status === 200 && (await health.json()).ok === true, "Native artifact healthz failed");
    const runtimeResponse = await request("/api/runtime");
    check(runtimeResponse.status === 200, "Native artifact runtime endpoint failed");
    const runtime = await runtimeResponse.json();
    report.version = runtime.version;
    check(runtime.version === expectedVersion, `Native artifact version ${runtime.version} differs from expected ${expectedVersion}`);
    check(runtime.port === Number(baseUrl.port), "Native artifact runtime port differs from its bound port");
    check(runtime.canShutdown === true && runtime.relayEnabled === true, "Native artifact local runtime capabilities are incorrect");
    check(Array.isArray(runtime.lanUrls) && typeof runtime.recommendedUrl === "string", "Native artifact runtime address data is missing");

    const webRoot = join(sourceRoot, "src/web");
    const assets: Array<[string, string]> = [["/", join(webRoot, "index.html")]];
    for (const name of (await readdir(webRoot)).sort()) {
      if (/\.(html|css|js)$/.test(name)) assets.push([`/${name}`, join(webRoot, name)]);
    }
    assets.push(["/vendor/tweetnacl.js", join(sourceRoot, "node_modules/tweetnacl/nacl-fast.min.js")]);
    for (const [route, file] of assets) {
      const response = await request(route);
      check(response.status === 200, `Native artifact asset ${route} returned HTTP ${response.status}`);
      const actual = Buffer.from(await response.arrayBuffer());
      const expected = Buffer.from(await Bun.file(file).arrayBuffer());
      check(actual.equals(expected), `Native artifact asset ${route} bytes differ from source`);
      report.assetCount += 1;
    }
    const rejected = await request("/api/shutdown", { method: "POST" });
    report.shutdownUnauthorizedStatus = rejected.status;
    check(rejected.status === 403, "Native artifact accepted shutdown without local action headers");
    check((await request("/healthz")).status === 200, "Rejected shutdown stopped the native artifact");
    const accepted = await request("/api/shutdown", {
      method: "POST", headers: { origin: baseUrl.origin, "x-dukou-action": "shutdown" },
    });
    report.shutdownStatus = accepted.status;
    check(accepted.status === 200 && (await accepted.json()).ok === true, "Native artifact rejected authorized local shutdown");
    report.exitCode = await deadline(child.exited, timeoutMs, "Native artifact did not exit after authorized shutdown");
    check(report.exitCode === 0, `Native artifact shutdown exit code was ${report.exitCode}`);
    const hash = createHash("sha256");
    for await (const chunk of Bun.file(binaryPath).stream()) hash.update(chunk);
    report.sha256 = hash.digest("hex").toUpperCase();
    report.ok = true;
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  } finally {
    if (child && child.exitCode === null) {
      report.forcedCleanup = true;
      child.kill();
      report.exitCode = await deadline(child.exited, timeoutMs, "Could not clean up owned native artifact process");
    }
    await Promise.all([readOutput, readErrors]);
    await rm(cwd, { recursive: true, force: true });
  }
  if (failure) {
    if (stderr.trim()) failure.message += `\nNative stderr: ${stderr.trim()}`;
    throw Object.assign(failure, { smokeReport: report });
  }
  return report;
}

if (import.meta.main) {
  const [binaryPath] = process.argv.slice(2);
  if (!binaryPath || binaryPath === "--help") {
    console.log("Usage: bun scripts/smoke-binary.ts <compiled-native-binary>");
    if (!binaryPath) process.exitCode = 1;
  } else {
    try {
      console.log(JSON.stringify(await smokeBinary({ binaryPath }), null, 2));
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    }
  }
}
