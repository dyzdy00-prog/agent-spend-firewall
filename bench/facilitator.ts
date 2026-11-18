// Local x402 facilitator for Solana devnet (exact scheme only). Bench use, testnet keys only.
// Why: the public facilitator (https://x402.org/facilitator) fails Solana settlement with RPC 429.
// Run: node bench/facilitator.ts   (env: FACILITATOR_PORT=4100, SVM_RPC_URL=https://api.devnet.solana.com)
// Fee payer: 64-byte keypair JSON at ~/.agent-spend-firewall/facilitator-keys/svm.key (mode 0600).
// Fund the printed address with devnet SOL (https://faucet.solana.com). Key material is never printed.
// express ships no types here (transitive dependency of @x402/express); loosely typed on purpose.
// @ts-ignore
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { x402Facilitator } from "@x402/core/facilitator";
import { toFacilitatorSvmSigner } from "@x402/svm";
import { registerExactSvmScheme } from "@x402/svm/exact/facilitator";
import { loadOrCreateKeys } from "../src/keys.ts";

interface Req { body: { paymentPayload?: never; paymentRequirements?: never } }
interface Res { json(b: unknown): void; status(c: number): Res }

const SVM_NET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const PORT = Number(process.env.FACILITATOR_PORT ?? 4100);
const RPC = process.env.SVM_RPC_URL ?? "https://api.devnet.solana.com";
const KEY_DIR = path.join(os.homedir(), ".agent-spend-firewall", "facilitator-keys");

// Same checks as src/keys.ts (dir not group/other accessible, file 0600), reading only svm.key.
function readFeePayerBytes(): Uint8Array {
  const file = path.join(KEY_DIR, "svm.key");
  if (!fs.existsSync(file)) {
    console.error(`facilitator: no fee payer key at ${file}`);
    console.error("create a testnet key with: FACILITATOR_CREATE_KEY=1 node bench/facilitator.ts");
    process.exit(1);
  }
  if ((fs.lstatSync(KEY_DIR).mode & 0o077) !== 0) {
    console.error("facilitator: key dir permissions allow group/other access");
    process.exit(1);
  }
  const st = fs.lstatSync(file);
  if (!st.isFile() || (st.mode & 0o777) !== 0o600) {
    console.error("facilitator: svm.key must be a regular file with mode 0600");
    process.exit(1);
  }
  let arr: unknown;
  try {
    arr = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    arr = null;
  }
  if (!Array.isArray(arr) || arr.length !== 64 || !arr.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    console.error("facilitator: svm.key is malformed");
    process.exit(1);
  }
  return Uint8Array.from(arr as number[]);
}

if (!fs.existsSync(path.join(KEY_DIR, "svm.key")) && process.env.FACILITATOR_CREATE_KEY === "1") {
  loadOrCreateKeys(KEY_DIR); // testnet keys only
}
const keypair = await createKeyPairSignerFromBytes(readFeePayerBytes());
const facilitator = new x402Facilitator();
registerExactSvmScheme(facilitator, {
  signer: toFacilitatorSvmSigner(keypair, { defaultRpcUrl: RPC }),
  networks: SVM_NET,
});

const app = express();
app.use(express.json({ limit: "256kb" }));

app.get("/supported", (_req: unknown, res: Res) => {
  res.json(facilitator.getSupported());
});
app.post("/verify", async (req: Req, res: Res) => {
  try {
    res.json(await facilitator.verify(req.body.paymentPayload as never, req.body.paymentRequirements as never));
  } catch (e) {
    res.status(400).json({ isValid: false, invalidReason: "facilitator_error", invalidMessage: String((e as Error).message) });
  }
});
app.post("/settle", async (req: Req, res: Res) => {
  try {
    res.json(await facilitator.settle(req.body.paymentPayload as never, req.body.paymentRequirements as never));
  } catch (e) {
    const msg = String((e as Error).message);
    console.error(`settle failed: ${msg.slice(0, 300)}`);
    res.status(400).json({ success: false, errorReason: "settle_error", errorMessage: msg, transaction: "", network: SVM_NET });
  }
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`bench facilitator (solana devnet, exact) on http://127.0.0.1:${PORT}`);
  console.log(`fee payer address: ${keypair.address}  rpc: ${RPC}`);
});
