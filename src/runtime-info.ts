import type { NetworkInterfaceInfo } from "node:os";

export type NetworkInterfaces = NodeJS.Dict<NetworkInterfaceInfo[]>;

export interface RuntimeInfo {
  version: string;
  port: number;
  lanUrls: string[];
  recommendedUrl: string;
}

function addressPriority(name: string, address: string): number {
  const adapter = name.toLowerCase();
  if (/tun|tap|vpn|jiux/.test(adapter) || /^198\.(1[89])\./.test(address)) return 9;
  if (/wsl|docker|virtual|vmware|hyper-v|vethernet|loopback/.test(adapter)) return 8;
  if (/wi-?fi|wlan|wireless|ethernet|以太网|无线/.test(adapter)) return 0;
  if (/^192\.168\./.test(address)) return 1;
  if (/^10\./.test(address)) return 2;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) return 3;
  if (/^169\.254\./.test(address)) return 8;
  return 4;
}

export function listLanAddresses(interfaces: NetworkInterfaces): string[] {
  const candidates: Array<{ name: string; address: string }> = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      const family = typeof entry.family === "string" ? entry.family : String(entry.family);
      if (entry.internal || family !== "IPv4" || entry.address === "0.0.0.0") continue;
      candidates.push({ name, address: entry.address });
    }
  }
  candidates.sort(
    (left, right) =>
      addressPriority(left.name, left.address) - addressPriority(right.name, right.address) ||
      left.name.localeCompare(right.name) ||
      left.address.localeCompare(right.address),
  );
  return [...new Set(candidates.map(({ address }) => address))];
}

export function createRuntimeInfo(
  interfaces: NetworkInterfaces,
  port: number,
  version: string,
): RuntimeInfo {
  const lanUrls = listLanAddresses(interfaces).map((address) => `http://${address}:${port}`);
  return {
    version,
    port,
    lanUrls,
    recommendedUrl: lanUrls[0] ?? `http://127.0.0.1:${port}`,
  };
}
