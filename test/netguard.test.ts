// Tests for the SSRF guard (#8) and the settle-reason reader (#15). Written with the code in view.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { BlockedAddressError, guardedGet, isBlockedAddress } from "../src/netguard.ts";
import { settleReasonFromHeader } from "../src/firewall.ts";

describe("isBlockedAddress", () => {
  const blocked = ["127.0.0.1", "127.255.255.254", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254",
    "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "::1", "::", "fe80::1", "fd00::1", "fc00::1", "ff02::1",
    "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::10.0.0.1", "2001:db8::1", "not-an-ip"];
  const open = ["8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"];
  for (const ip of blocked) it(`blocks ${ip}`, () => assert.equal(isBlockedAddress(ip), true));
  for (const ip of open) it(`allows ${ip}`, () => assert.equal(isBlockedAddress(ip), false));
});

describe("guardedGet", () => {
  const opts = (allowPrivate: boolean) => ({ allowPrivate, timeoutMs: 3000, maxBody: 1000 });
  async function withServer(fn: (port: number, hits: () => number) => Promise<void>) {
    let n = 0;
    const s = http.createServer((_q, r) => { n++; r.writeHead(200, { "x-a": "1" }); r.end("x".repeat(5000)); });
    await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
    try { await fn((s.address() as AddressInfo).port, () => n); } finally { s.close(); }
  }
  it("refuses loopback by literal IP and by name, without connecting", () => withServer(async (port, hits) => {
    await assert.rejects(guardedGet(`http://127.0.0.1:${port}/`, {}, opts(false)), BlockedAddressError);
    await assert.rejects(guardedGet(`http://localhost:${port}/`, {}, opts(false)), BlockedAddressError);
    await assert.rejects(guardedGet(`http://[::1]:${port}/`, {}, opts(false)), BlockedAddressError);
    assert.equal(hits(), 0);
  }));
  it("allowlisted host works; body is capped; headers kept", () => withServer(async (port) => {
    const r = await guardedGet(`http://127.0.0.1:${port}/`, {}, opts(true));
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("x-a"), "1");
    assert.equal(r.body.length, 1000);
  }));
});

describe("settleReasonFromHeader", () => {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64");
  it("reads errorReason from a failed settlement", () => {
    assert.equal(settleReasonFromHeader(b64({ success: false, errorReason: "invalid_exact_evm_transaction_failed", errorMessage: "long text" })), "invalid_exact_evm_transaction_failed");
  });
  it("ignores success, junk and unsafe reasons", () => {
    assert.equal(settleReasonFromHeader(b64({ success: true })), undefined);
    assert.equal(settleReasonFromHeader("%%%"), undefined);
    assert.equal(settleReasonFromHeader(null), undefined);
    assert.equal(settleReasonFromHeader(b64({ success: false, errorReason: "<script>" })), undefined);
  });
});
