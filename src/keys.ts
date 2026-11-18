// M5: key custody. Testnet keys only. Key material never leaves this module except via readKeyMaterial (used by signers.ts).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { generateKeyPairSync } from "node:crypto";
import { getAddressDecoder } from "@solana/kit";

export function defaultKeyDir(): string {
  return process.env.ASF_KEY_DIR ?? path.join(os.homedir(), ".agent-spend-firewall", "keys");
}

const EVM_KEY = /^0x[0-9a-f]{64}$/;

export class KeyFileError extends Error {}

function fail(what: string): never {
  // Messages never include file contents.
  throw new KeyFileError(`key custody: ${what}`);
}

function checkDir(dir: string): void {
  const st = fs.lstatSync(dir);
  if (!st.isDirectory()) fail("key dir is not a directory");
  if ((st.mode & 0o077) !== 0) fail("key dir permissions allow group/other access");
}

function checkFile(file: string): void {
  const st = fs.lstatSync(file);
  if (!st.isFile()) fail(`${path.basename(file)} is not a regular file`);
  if ((st.mode & 0o777) !== 0o600) fail(`${path.basename(file)} must have mode 0600`);
}

function parseEvm(text: string): `0x${string}` {
  const t = text.trim();
  if (!EVM_KEY.test(t)) fail("evm.key is malformed");
  return t as `0x${string}`;
}

function parseSvm(text: string): Uint8Array {
  let arr: unknown;
  try {
    arr = JSON.parse(text);
  } catch {
    fail("svm.key is malformed");
  }
  if (!Array.isArray(arr) || arr.length !== 64 || !arr.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    fail("svm.key is malformed");
  }
  return Uint8Array.from(arr as number[]);
}

function makeSvmBytes(): Uint8Array {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = Buffer.from(privateKey.export({ format: "der", type: "pkcs8" })).subarray(-32);
  const pub = Buffer.from(publicKey.export({ format: "der", type: "spki" })).subarray(-32);
  const out = new Uint8Array(64);
  out.set(seed, 0);
  out.set(pub, 32);
  return out;
}

function ensureFiles(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  checkDir(dir);
  const evm = path.join(dir, "evm.key");
  const svm = path.join(dir, "svm.key");
  if (!fs.existsSync(evm)) fs.writeFileSync(evm, generatePrivateKey(), { mode: 0o600, flag: "wx" });
  if (!fs.existsSync(svm)) fs.writeFileSync(svm, JSON.stringify(Array.from(makeSvmBytes())), { mode: 0o600, flag: "wx" });
}

/** Module-private reader. Returns key material; only signers.ts may call it. */
export function readKeyMaterial(dir: string): { evmKey: `0x${string}`; svmBytes: Uint8Array } {
  checkDir(dir);
  const evm = path.join(dir, "evm.key");
  const svm = path.join(dir, "svm.key");
  checkFile(evm);
  checkFile(svm);
  return { evmKey: parseEvm(fs.readFileSync(evm, "utf8")), svmBytes: parseSvm(fs.readFileSync(svm, "utf8")) };
}

export function loadOrCreateKeys(dir: string): { evmAddress: `0x${string}`; svmAddress: string } {
  ensureFiles(dir);
  const { evmKey, svmBytes } = readKeyMaterial(dir);
  const evmAddress = privateKeyToAccount(evmKey).address;
  // Solana address = base58 of the public half (bytes 32..64).
  const svmAddress = getAddressDecoder().decode(svmBytes.subarray(32));
  return { evmAddress, svmAddress };
}
