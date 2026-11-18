// Firewall x Solana, offline: a stub JSON-RPC server stands in for devnet (blockhash + mint account),
// a fake seller returns a v2 402 with a Solana requirement. No network, no funds.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { getTransactionDecoder, getPublicKeyFromAddress, signatureBytes, verifySignature } from "@solana/kit";
import type { Address } from "@solana/kit";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { parseConfig, startFirewall } from "../src/firewall.ts";
import type { FetchResult } from "../src/firewall.ts";
import { readSvm } from "../src/svm.ts";

const NET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const PAYEE = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const FEE_PAYER = "3h3yW8Jj5xaooTHXDm72DRMkBa5iVSv1ugqHr1abqkpv"; // fake: nobody holds a key for this in the test
const TOKEN = "tok-agent-svm-secret";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "asf-fwsvm-"));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

// ---- stub JSON-RPC: only what ExactSvmScheme (client) calls
function startRpc() {
  const methods: string[] = [];
  // SPL Mint account: 82 bytes, decimals at 44, is_initialized at 45, everything else zero.
  const mint = Buffer.alloc(82);
  mint[44] = 6;
  mint[45] = 1;
  const server = http.createServer((rq, rs) => {
    let body = "";
    rq.on("data", (c) => (body += c));
    rq.on("end", () => {
      const { id, method } = JSON.parse(body) as { id: unknown; method: string };
      methods.push(method);
      let result: unknown;
      if (method === "getLatestBlockhash") {
        result = { context: { slot: 100 }, value: { blockhash: MINT, lastValidBlockHeight: 1000 } }; // any 32-byte base58
      } else if (method === "getAccountInfo" || method === "getMultipleAccounts") {
        const acct = { data: [mint.toString("base64"), "base64"], executable: false, lamports: 1000000, owner: TOKEN_PROGRAM, rentEpoch: 0, space: 82 };
        result = { context: { slot: 100 }, value: method === "getAccountInfo" ? acct : [acct] };
      } else {
        rs.writeHead(200, { "content-type": "application/json" });
        return void rs.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: `stub: ${method} not implemented` } }));
      }
      rs.writeHead(200, { "content-type": "application/json" });
      rs.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    });
  });
  return new Promise<{ url: string; methods: string[]; close(): Promise<void> }>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({
      url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, methods,
      close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
    })));
}

// ---- fake seller (402 with a Solana requirement; with payment -> 200)
interface Seen { path: string; paid: PaymentPayload | null }
function startSeller(amount: () => string) {
  const seen: Seen[] = [];
  const server = http.createServer((rq, rs) => {
    const sig = rq.headers["payment-signature"];
    const paid = typeof sig === "string" ? (decodePaymentSignatureHeader(sig) as unknown as PaymentPayload) : null;
    seen.push({ path: rq.url ?? "/", paid });
    if (paid) {
      rs.writeHead(200, { "payment-response": encodePaymentResponseHeader({ success: true, transaction: "5igTestSig", network: NET, payer: "x" } as never) });
      return void rs.end("paid content");
    }
    const accept: PaymentRequirements = {
      scheme: "exact", network: NET, asset: MINT, amount: amount(), payTo: PAYEE, maxTimeoutSeconds: 60,
      extra: { feePayer: FEE_PAYER },
    };
    const pr: PaymentRequired = { x402Version: 2, error: "payment required", resource: { url: "http://x/" }, accepts: [accept] };
    rs.writeHead(402, { "payment-required": encodePaymentRequiredHeader(pr) });
    rs.end("{}");
  });
  return new Promise<{ host: string; seen: Seen[]; accept: PaymentRequirements; close(): Promise<void> }>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const host = `127.0.0.1:${(server.address() as { port: number }).port}`;
      resolve({
        host, seen, accept: null as never,
        close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }),
      });
    }));
}

async function rig(amount: string) {
  const rpc = await startRpc();
  const seller = await startSeller(() => amount);
  const dir = fs.mkdtempSync(path.join(tmpRoot, "r-"));
  const logPath = path.join(dir, "decisions.jsonl");
  const cfg = parseConfig({
    listen: { host: "127.0.0.1", port: 0 }, keyDir: path.join(dir, "keys"), storePath: path.join(dir, "state.db"), logPath,
    svmRpcUrl: rpc.url,
    allowPrivateHosts: [seller.host],
    agents: { [sha(TOKEN)]: "agent-1" },
    assets: [{ network: NET, asset: MINT, decimals: 6, usd_per_unit: "1", svm_token_program: TOKEN_PROGRAM }],
    policy: {
      networks: [NET], cap_usd: "0.05", budget_usd: "1", window_s: 3600, max_validity_s: 300, min_amount_usd: "0.000001",
      max_signatures_per_window: 100, known_hosts_only: false, payees: {}, block_after_undelivered: 0, undelivered_window_s: 3600,
      agents: { "agent-1": { budget_usd: "1" } },
    },
  });
  const fw = await startFirewall(cfg);
  const call = async (url: string) => {
    const r = await fetch(`http://127.0.0.1:${fw.port}/fetch`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ url }) });
    return (await r.json()) as FetchResult;
  };
  const readLog = () => fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { fw, rpc, seller, call, readLog, close: async () => { await fw.close(); await seller.close(); await rpc.close(); } };
}

describe("firewall on Solana (offline)", () => {
  it("allowed payment: one transaction, passes readSvm, payer signature verifies, allow logged", async () => {
    const r = await rig("10000"); // $0.01 <= cap $0.05
    try {
      const res = await r.call(`http://${r.seller.host}/good`);
      assert.equal(res.status, 200, JSON.stringify(res));
      assert.equal(res.refused, null);
      assert.equal(res.paid?.network, NET);
      const paid = r.seller.seen.filter((s) => s.paid);
      assert.equal(paid.length, 1, "exactly one signed request reached the seller");

      const payer = r.fw.firewall.addresses.svm;
      const b64 = (paid[0]!.paid!.payload as { transaction: string }).transaction;
      const tx = getTransactionDecoder().decode(Buffer.from(b64, "base64"));
      // The fee payer (account 0) is the facilitator's: its slot is empty, the payer's is filled.
      assert.equal(tx.signatures[FEE_PAYER as Address], null);
      const sig = tx.signatures[payer as Address];
      assert.ok(sig, "payer signature present");
      const pub = await getPublicKeyFromAddress(payer as Address);
      assert.equal(await verifySignature(pub, signatureBytes(sig!), tx.messageBytes), true, "signature verifies over the message bytes");

      // The signed message passes the reader with the original requirement.
      const read = await readSvm(new Uint8Array(tx.messageBytes), {
        payer, host: r.seller.host, agent: "agent-1", now: Math.floor(Date.now() / 1000),
        assets: [{ network: NET, asset: MINT, decimals: 6, usd_per_unit: "1", svm_token_program: TOKEN_PROGRAM } as never],
        expected: { network: NET, asset: MINT, amount: 10000n, payTo: PAYEE, maxTimeoutSeconds: 60 },
      });
      assert.equal(read.ok, true, read.ok ? "" : read.reason);
      // And the payee really is the destination owner: readSvm checks the ATA, so a different payee must fail.
      const wrong = await readSvm(new Uint8Array(tx.messageBytes), {
        payer, host: r.seller.host, agent: "agent-1", now: Math.floor(Date.now() / 1000),
        assets: [{ network: NET, asset: MINT, decimals: 6, usd_per_unit: "1", svm_token_program: TOKEN_PROGRAM } as never],
        expected: { network: NET, asset: MINT, amount: 10000n, payTo: FEE_PAYER, maxTimeoutSeconds: 60 },
      });
      assert.equal(wrong.ok, false);

      const log = r.readLog();
      assert.equal(log.length, 1);
      assert.equal(log[0].allow, true);
      assert.equal(log[0].network, NET);
      assert.equal(log[0].payee, PAYEE);
      // Only the stub's two methods were needed from the RPC.
      assert.ok(r.rpc.methods.includes("getLatestBlockhash"));
    } finally { await r.close(); }
  });

  it("CAP refusal on Solana: nothing signed, refusal logged", async () => {
    const r = await rig("5000000"); // $5 > cap $0.05
    try {
      const res = await r.call(`http://${r.seller.host}/pricey`);
      assert.equal(res.refused?.code, "CAP");
      assert.equal(res.paid, null);
      assert.equal(r.seller.seen.filter((s) => s.paid).length, 0);
      const log = r.readLog();
      assert.equal(log.length, 1);
      assert.equal(log[0].allow, false);
      assert.equal(log[0].code, "CAP");
    } finally { await r.close(); }
  });
});
