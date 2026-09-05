import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repository = resolve(import.meta.dir, "..");
let fixture: string;
let binaryPath: string;

beforeAll(async () => {
  fixture = await mkdtemp(join(tmpdir(), "dukou-smoke-fixture-"));
  await cp(join(repository, "src"), join(fixture, "src"), { recursive: true });
  await cp(join(repository, "package.json"), join(fixture, "package.json"));
  await cp(join(repository, "node_modules/tweetnacl"), join(fixture, "node_modules/tweetnacl"), { recursive: true });
  binaryPath = join(fixture, process.platform === "win32" ? "dukou.exe" : "dukou");
  const build = Bun.spawn([process.execPath, "build", join(fixture, "src/server.ts"), "--compile", "--outfile", binaryPath], { stdout: "pipe", stderr: "pipe" });
  const [status, errors] = await Promise.all([build.exited, new Response(build.stderr).text()]);
  if (status !== 0) throw new Error(`Native smoke fixture did not compile: ${errors}`);
}, 60_000);

afterAll(async () => {
  if (fixture) await rm(fixture, { recursive: true, force: true });
});

async function implementation() {
  const script = join(repository, "scripts/smoke-binary.ts");
  expect(await Bun.file(script).exists()).toBe(true);
  return import(script);
}

describe("native artifact smoke", () => {
  test.serial("checks real embedded bytes outside the source cwd and shuts down its own process", async () => {
    const { smokeBinary } = await implementation();
    const result = await smokeBinary({ binaryPath, sourceRoot: fixture });
    expect(result.ok).toBe(true);
    expect(result.version).toBe("0.2.0");
    expect(result.assetCount).toBeGreaterThanOrEqual(10);
    expect(result.sha256).toMatch(/^[A-F0-9]{64}$/);
    expect(result.shutdownUnauthorizedStatus).toBe(403);
    expect(result.shutdownStatus).toBe(200);
    expect(result.exitCode).toBe(0);
    expect(result.forcedCleanup).toBe(false);
    expect(result.cwd.startsWith(fixture)).toBe(false);
    expect(await stat(result.cwd).catch(() => null)).toBeNull();
  }, 30_000);

  test.serial("rejects an artifact with the wrong version and cleans only the process it created", async () => {
    const { smokeBinary } = await implementation();
    const error = await smokeBinary({ binaryPath, sourceRoot: fixture, expectedVersion: "999.0.0" }).catch((value: Error) => value);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("version");
    expect(error.smokeReport.forcedCleanup).toBe(true);
    expect(error.smokeReport.exitCode).not.toBeNull();
    expect(await stat(error.smokeReport.cwd).catch(() => null)).toBeNull();
  }, 30_000);

  test.serial("rejects stale embedded assets instead of accepting HTTP 200 as a pass", async () => {
    const { smokeBinary } = await implementation();
    const cssPath = join(fixture, "src/web/app.css");
    const original = await Bun.file(cssPath).arrayBuffer();
    try {
      await Bun.write(cssPath, "/* bytes changed after compilation */");
      const error = await smokeBinary({ binaryPath, sourceRoot: fixture }).catch((value: Error) => value);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toContain("/app.css");
      expect(error.message).toContain("bytes");
      expect(error.smokeReport.forcedCleanup).toBe(true);
      expect(error.smokeReport.exitCode).not.toBeNull();
    } finally {
      await Bun.write(cssPath, original);
    }
  }, 30_000);
});
