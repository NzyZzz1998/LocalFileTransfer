import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

async function readReadyUrl(child: ReturnType<typeof Bun.spawn>) {
  const reader = child.stdout.getReader();
  const chunk = await Promise.race([
    reader.read(),
    Bun.sleep(2_000).then(() => {
      throw new Error("built server did not report a URL");
    }),
  ]);
  const output = new TextDecoder().decode(chunk.value);
  const url = output.match(/http:\/\/127\.0\.0\.1:\d+\//)?.[0];
  if (!url) throw new Error(`missing ready URL in: ${output}`);
  return url;
}

describe("distribution build", () => {
  test.serial("bundled server embeds every browser asset", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "dukou-bundle-"));
    let child: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const result = await Bun.build({
        entrypoints: [resolve(root, "src/server.ts")],
        outdir: outputDirectory,
        target: "bun",
      });
      expect(result.success).toBe(true);
      const entry = result.outputs.find((output) => output.path.endsWith("server.js"));
      expect(entry).toBeDefined();
      child = Bun.spawn([process.execPath, entry!.path], {
        cwd: outputDirectory,
        env: { ...process.env, HOST: "127.0.0.1", PORT: "0" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const baseUrl = await readReadyUrl(child);

      for (const [route, source] of [
        ["/", "src/web/index.html"],
        ["/app.css", "src/web/app.css"],
        ["/app.js", "src/web/app.js"],
        ["/peer-session.js", "src/web/peer-session.js"],
        ["/transfer.js", "src/web/transfer.js"],
        ["/storage.js", "src/web/storage.js"],
      ]) {
        const response = await fetch(new URL(route, baseUrl));
        expect(response.status).toBe(200);
        expect(await response.text()).toBe(await Bun.file(resolve(root, source)).text());
      }
    } finally {
      child?.kill();
      if (child) await child.exited;
      await rm(outputDirectory, { recursive: true, force: true });
    }
  });
});
