import { describe, expect, test } from "bun:test";
import { createRuntimeInfo, listLanAddresses } from "../src/runtime-info";

const ipv4 = (address: string, internal = false) => ({
  address,
  netmask: "255.255.255.0",
  family: "IPv4" as const,
  mac: "00:00:00:00:00:00",
  internal,
  cidr: `${address}/24`,
});

describe("runtime LAN address discovery", () => {
  test("prefers a physical LAN adapter, removes duplicates, and excludes loopback/IPv6", () => {
    const addresses = listLanAddresses({
      "JiuX TUN": [ipv4("198.18.0.1")],
      "vEthernet (Default Switch)": [ipv4("172.21.32.1")],
      Loopback: [ipv4("127.0.0.1", true)],
      WiFi: [ipv4("192.168.31.73"), ipv4("192.168.31.73")],
      IPv6: [
        {
          ...ipv4("fe80::1"),
          family: "IPv6",
          cidr: "fe80::1/64",
          scopeid: 2,
        },
      ],
    });

    expect(addresses).toEqual(["192.168.31.73", "172.21.32.1", "198.18.0.1"]);
  });

  test("falls back to localhost without claiming it is reachable from another device", () => {
    expect(createRuntimeInfo({}, 3000, "0.2.0")).toEqual({
      version: "0.2.0",
      port: 3000,
      lanUrls: [],
      recommendedUrl: "http://127.0.0.1:3000",
    });
  });
});
