// Practice facilitator for `npm start -- --practice`: checks the payment like a facilitator would, then answers
// "settled" WITHOUT sending anything to a chain. No key, no RPC, no network. Never use it for a real seller.
// Why: the public test facilitator fails to settle now and then, and a first-time user has no test USDC at all;
// either way every practice purchase showed up as "not delivered". With this, the firewall's own behaviour
// (policy, signing, cache, budget, approvals) can be tried end to end, and the console says that no money moves.
// Run: node bench/practice-facilitator.ts   (env: PRACTICE_FACILITATOR_PORT=4020)
import http from "node:http";
import { fileURLToPath } from "node:url";
import { verifyTypedData } from "viem";

export const PRACTICE_NETWORK = "eip155:84532";
const CHAIN_ID = 84532;
const MAX_BODY = 256 * 1024;
const MAX_NONCES = 10_000;
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const UINT = /^[0-9]{1,78}$/;

const TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export interface Checked { ok: true; payer: `0x${string}`; nonceKey: string }
export interface Rejected { ok: false; reason: string; payer?: string }

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const obj = (v: unknown): Record<string, unknown> | null => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** The checks a real facilitator makes that do not need a chain: shape, recipient, amount, time window, signature. */
export async function checkPayment(paymentPayload: unknown, paymentRequirements: unknown, nowS: number): Promise<Checked | Rejected> {
  const p = obj(paymentPayload), r = obj(paymentRequirements);
  if (!p || !r) return { ok: false, reason: "practice_bad_request" };
  if (p["x402Version"] !== 2) return { ok: false, reason: "practice_unsupported_version" };
  if (r["scheme"] !== "exact" || r["network"] !== PRACTICE_NETWORK) return { ok: false, reason: "practice_unsupported_scheme_or_network" };
  const acc = obj(p["accepted"]);
  if (!acc || acc["scheme"] !== "exact" || acc["network"] !== PRACTICE_NETWORK) return { ok: false, reason: "practice_accepted_mismatch" };
  const inner = obj(p["payload"]);
  const auth = obj(inner?.["authorization"]);
  const signature = str(inner?.["signature"]);
  if (!auth || !signature || !/^0x[0-9a-fA-F]{130,}$/.test(signature)) return { ok: false, reason: "practice_bad_payload" };
  const from = str(auth["from"]), to = str(auth["to"]), value = str(auth["value"]);
  const validAfter = str(auth["validAfter"]), validBefore = str(auth["validBefore"]), nonce = str(auth["nonce"]);
  if (!from || !ADDR.test(from) || !to || !ADDR.test(to) || !value || !UINT.test(value) || !validAfter || !UINT.test(validAfter)
    || !validBefore || !UINT.test(validBefore) || !nonce || !HEX32.test(nonce)) return { ok: false, reason: "practice_bad_authorization" };
  const payTo = str(r["payTo"]), asset = str(r["asset"]), amount = str(r["amount"]);
  const extra = obj(r["extra"]);
  const name = str(extra?.["name"]), version = str(extra?.["version"]);
  if (!payTo || !ADDR.test(payTo) || !asset || !ADDR.test(asset) || !amount || !UINT.test(amount) || !name || !version) return { ok: false, reason: "practice_bad_requirements", payer: from };
  if (to.toLowerCase() !== payTo.toLowerCase()) return { ok: false, reason: "practice_recipient_mismatch", payer: from };
  if (BigInt(value) !== BigInt(amount)) return { ok: false, reason: "practice_amount_mismatch", payer: from };
  if (BigInt(validAfter) > BigInt(nowS)) return { ok: false, reason: "practice_not_yet_valid", payer: from };
  if (BigInt(validBefore) <= BigInt(nowS)) return { ok: false, reason: "practice_expired", payer: from };
  let good = false;
  try {
    good = await verifyTypedData({
      address: from as `0x${string}`,
      domain: { name, version, chainId: CHAIN_ID, verifyingContract: asset as `0x${string}` },
      types: TYPES,
      primaryType: "TransferWithAuthorization",
      message: { from: from as `0x${string}`, to: to as `0x${string}`, value: BigInt(value), validAfter: BigInt(validAfter), validBefore: BigInt(validBefore), nonce: nonce as `0x${string}` },
      signature: signature as `0x${string}`,
    });
  } catch { good = false; }
  if (!good) return { ok: false, reason: "practice_bad_signature", payer: from };
  return { ok: true, payer: from as `0x${string}`, nonceKey: `${from.toLowerCase()}:${nonce.toLowerCase()}` };
}

export function createPracticeFacilitator(now: () => number = () => Math.floor(Date.now() / 1000)): http.Server {
  // An authorization settles once, as on chain. Oldest entries go first when the set is full.
  const used = new Set<string>();
  const send = (res: http.ServerResponse, status: number, body: unknown) => {
    const b = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(b), "cache-control": "no-store" });
    res.end(b);
  };
  const read = (req: http.IncomingMessage): Promise<Record<string, unknown> | null> => new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0, over = false;
    req.on("data", (c: Buffer) => { size += c.length; if (size > MAX_BODY) over = true; else chunks.push(c); });
    req.on("end", () => {
      if (over) return resolve(null);
      try { resolve(obj(JSON.parse(Buffer.concat(chunks).toString("utf8")))); } catch { resolve(null); }
    });
    req.on("error", () => resolve(null));
  });
  return http.createServer(async (req, res) => {
    const p = (req.url ?? "/").split("?")[0];
    if (req.method === "GET" && p === "/supported") {
      return send(res, 200, { kinds: [{ x402Version: 2, scheme: "exact", network: PRACTICE_NETWORK }], extensions: [], signers: {} });
    }
    if (req.method === "POST" && (p === "/verify" || p === "/settle")) {
      const body = await read(req);
      const c = body ? await checkPayment(body["paymentPayload"], body["paymentRequirements"], now()) : ({ ok: false, reason: "practice_bad_request" } as Rejected);
      const replay = c.ok && used.has(c.nonceKey);
      if (p === "/verify") {
        if (!c.ok) return send(res, 200, { isValid: false, invalidReason: c.reason, ...(c.payer ? { payer: c.payer } : {}) });
        if (replay) return send(res, 200, { isValid: false, invalidReason: "practice_nonce_used", payer: c.payer });
        return send(res, 200, { isValid: true, payer: c.payer });
      }
      if (!c.ok) return send(res, 200, { success: false, errorReason: c.reason, transaction: "", network: PRACTICE_NETWORK, ...(c.payer ? { payer: c.payer } : {}) });
      if (replay) return send(res, 200, { success: false, errorReason: "practice_nonce_used", transaction: "", network: PRACTICE_NETWORK, payer: c.payer });
      if (used.size >= MAX_NONCES) used.delete(used.values().next().value as string);
      used.add(c.nonceKey);
      // No transaction: nothing was sent anywhere.
      return send(res, 200, { success: true, transaction: "", network: PRACTICE_NETWORK, payer: c.payer });
    }
    send(res, 404, { error: "not found" });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PRACTICE_FACILITATOR_PORT ?? 4020);
  createPracticeFacilitator().listen(port, "127.0.0.1", () => {
    console.log(`practice facilitator on http://127.0.0.1:${port} (checks signatures, moves no money)`);
  });
}
