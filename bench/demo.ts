// One-command Base Sepolia demo: seller + firewall + demo agent, then a summary from the decision log.
// Run: npm run demo [-- --keep]     Testnet only. Prints no keys and no token.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadOrCreateKeys, defaultKeyDir } from "../src/keys.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const KEEP = process.argv.includes("--keep");
const BASE = path.join(os.homedir(), ".agent-spend-firewall");
const RPC = "https://sepolia.base.org";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const MIN_ATOMS = 100_000n; // 0.10 USDC
const SELLER_EVM_2 = "0x000000000000000000000000000000000000dEaD";
const EVM_NET = "eip155:84532";
const DASH = "http://127.0.0.1:8402/";

const kids: ChildProcess[] = [];
let stopped = false;
function stopAll(): void {
  if (stopped) return;
  stopped = true;
  for (const k of kids) if (k.exitCode === null) k.kill("SIGTERM");
}
process.on("SIGINT", () => { stopAll(); process.exit(130); });
process.on("SIGTERM", () => { stopAll(); process.exit(143); });

async function usdcBalance(addr: string): Promise<bigint> {
  const data = "0x70a08231" + addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: USDC, data }, "latest"] }),
    signal: AbortSignal.timeout(15000),
  });
  const j = (await r.json()) as { result?: string; error?: unknown };
  if (typeof j.result !== "string") throw new Error("balance query failed");
  return BigInt(j.result);
}
const fmt = (a: bigint) => `${a / 1_000_000n}.${(a % 1_000_000n).toString().padStart(6, "0")}`;

async function waitFor(url: string, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(1500) });
      return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

// 1. keys and balance
const payer = loadOrCreateKeys(defaultKeyDir());
const seller = loadOrCreateKeys(path.join(BASE, "seller-keys"));
console.log(`payer EVM address: ${payer.evmAddress}`);
let bal: bigint;
try { bal = await usdcBalance(payer.evmAddress); } catch (e) {
  console.error(`could not read balance from ${RPC}: ${(e as Error).message}`);
  process.exit(1);
}
console.log(`Base Sepolia USDC balance: ${fmt(bal)}`);
if (bal < MIN_ATOMS) {
  console.log("Not enough test USDC (need at least 0.10).");
  console.log(`Get free test USDC at https://faucet.circle.com : choose Base Sepolia, USDC, paste ${payer.evmAddress}`);
  process.exit(2);
}

// 2. state dir, token, config
const t = new Date();
const p2 = (n: number) => String(n).padStart(2, "0");
const stamp = `${t.getFullYear()}${p2(t.getMonth() + 1)}${p2(t.getDate())}-${p2(t.getHours())}${p2(t.getMinutes())}${p2(t.getSeconds())}`;
const stateDir = path.join(BASE, `demo-${stamp}`);
fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
const token = randomBytes(24).toString("hex");
fs.writeFileSync(path.join(stateDir, "agent.token"), token, { mode: 0o600 });
const logPath = path.join(stateDir, "decisions.jsonl");
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "bench", "config.example.json"), "utf8"));
cfg.keyDir = defaultKeyDir();
cfg.storePath = path.join(stateDir, "state.db");
cfg.logPath = logPath;
cfg.agents = { [createHash("sha256").update(token).digest("hex")]: "bench-agent" };
cfg.policy.networks = [EVM_NET];
const cfgPath = path.join(stateDir, "config.json");
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });
console.log(`state dir: ${stateDir}`);

// 3. start seller and firewall
const sellerProc = spawn(process.execPath, ["bench/seller.ts"], {
  cwd: ROOT, stdio: ["ignore", "ignore", "inherit"],
  env: { ...process.env, SELLER_NETWORKS: "evm", SELLER_EVM: seller.evmAddress, SELLER_EVM_2 },
});
const fwProc = spawn(process.execPath, ["src/server.ts", cfgPath], { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] });
kids.push(sellerProc, fwProc);
const sellerUp = await waitFor("http://127.0.0.1:4021/good", 20000);
const fwUp = await waitFor(DASH, 20000);
if (!sellerUp || !fwUp) {
  console.error(`startup failed (seller ${sellerUp ? "up" : "down"}, firewall ${fwUp ? "up" : "down"})`);
  stopAll();
  process.exit(1);
}
console.log("seller and firewall are up\n");

// 4. agent
const agent = spawn(process.execPath, ["bench/agent.ts"], {
  cwd: ROOT, stdio: "inherit", env: { ...process.env, AGENT_TOKEN: token },
});
const agentCode: number = await new Promise((res) => agent.on("exit", (c) => res(c ?? 1)));

// 5. summary from the decision log
interface Entry { allow?: boolean; code?: string; delivered?: boolean; tx?: string }
let entries: Entry[] = [];
try {
  entries = fs.readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Entry);
} catch { /* no log */ }
const allowed = entries.filter((e) => e.allow);
const delivered = allowed.filter((e) => e.delivered);
const refused = new Map<string, number>();
for (const e of entries) if (!e.allow) refused.set(e.code ?? "?", (refused.get(e.code ?? "?") ?? 0) + 1);
const txs = [...new Set(allowed.map((e) => e.tx).filter((x): x is string => typeof x === "string" && /^0x[0-9a-fA-F]{64}$/.test(x)))];
console.log("\n== summary ==");
console.log(`agent exit code: ${agentCode}`);
console.log(`decisions: ${entries.length}   allowed: ${allowed.length}   delivered: ${delivered.length}`);
console.log(`refused: ${refused.size === 0 ? "none" : [...refused].map(([c, n]) => `${c} x${n}`).join(", ")}`);
console.log(`settled transactions: ${txs.length}`);
for (const x of txs) console.log(`  https://sepolia.basescan.org/tx/${x}`);
console.log(`decision log: ${logPath}`);
console.log(`dashboard: ${DASH}`);

if (KEEP) {
  console.log(`\n--keep: seller PID ${sellerProc.pid}, firewall PID ${fwProc.pid} are still running.`);
  console.log(`Stop them with: kill ${sellerProc.pid} ${fwProc.pid}`);
  sellerProc.unref(); fwProc.unref();
  process.exit(agentCode === 0 ? 0 : 1);
}
stopAll();
process.exit(agentCode === 0 ? 0 : 1);
