import { describe, expect, test } from "bun:test";

const html = await Bun.file(new URL("../src/web/index.html", import.meta.url)).text();

describe("real transfer UI contract", () => {
  test("has distinct signaling, connection, sender progress, and error outlets", () => {
    for (const id of [
      "station-status-text",
      "sender-error",
      "sender-progress",
      "sender-progress-percent",
      "sender-progress-file",
      "sender-progress-bytes",
      "sender-waterline-fill",
      "receiver-connection-status",
      "receiver-error",
    ]) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  test("describes server retention as file-content retention", () => {
    expect(html).toContain("<dt>文件内容留存</dt><dd>无</dd>");
  });

  test("does not invent device identities that signaling cannot verify", () => {
    expect(html).toContain("一台浏览器请求接收");
    expect(html).toContain("<h3>来自发送方</h3>");
    expect(html).not.toContain("泊位 08");
  });
});
