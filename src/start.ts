// One command: `npm start`. Sets up on first run, starts the firewall and opens the owner console signed in.
//   npm start                 firewall + console
//   npm start -- --practice   also a local practice seller and one run of the demo agent, so the console has real decisions in it
//   npm start -- --practice --onchain   practice purchases settle on the testnet through the public facilitator (needs test USDC)
//   npm start -- --no-open    do not open a browser
// Testnets only. Prints no key and no token.
import { research } from "../agents/researcher.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expandHome, loadConfig, startFirewall, type FirewallOptions, type RunningFirewall } from "./firewall.ts";
import { defaultKeyDir, loadOrCreateKeys } from "./keys.ts";
import { defaultBaseDir, ensureSetup, readAdminToken } from "./setup.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRACTICE = process.argv.includes("--practice");
const NO_OPEN = process.argv.includes("--no-open");
const ONCHAIN = process.argv.includes("--onchain");
// Practice processes: the facilitator on the base port, five seller hosts after it (the fifth is used by the Researcher's notes only).
const PRACTICE_BASE = Number(process.env.ASF_PRACTICE_PORT ?? 4020);
const PRACTICE_PORTS = [1, 2, 3, 4, 5].map((i) => PRACTICE_BASE + i);
const SELLER_EVM_2 = "0x000000000000000000000000000000000000dEaD";

const kids: ChildProcess[] = [];
let running: RunningFirewall | null = null;
let stopping = false;
function stop(code: number): void {
  if (stopping) return;
  stopping = true;
  for (const k of kids) if (k.exitCode === null) k.kill("SIGTERM");
  const done = () => process.exit(code);
  if (running) void running.close().then(done, done); else done();
}
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));

function openBrowser(url: string): void {
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : ["xdg-open", [url]];
  try { spawn(cmd, args as string[], { stdio: "ignore", detached: true }).on("error", () => {}).unref(); } catch { /* no browser: the address is printed */ }
}

async function waitFor(url: string, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { await fetch(url, { signal: AbortSignal.timeout(1500) }); return true; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

try {
  const dir = defaultBaseDir();
  const template = JSON.parse(fs.readFileSync(path.join(ROOT, "bench", "config.example.json"), "utf8")) as Record<string, any>;
  const s = ensureSetup(dir, defaultKeyDir(), template);
  const cfg = loadConfig(s.configPath);
  // Practice sellers are on loopback, which the firewall refuses by default. Allowed for this run only; the file is not changed.
  if (PRACTICE) for (const p of PRACTICE_PORTS) if (!cfg.allowPrivateHosts.includes(`127.0.0.1:${p}`)) cfg.allowPrivateHosts.push(`127.0.0.1:${p}`);

  // The demo agent runs by itself only into an empty log; after that the Practice panel is the way to act.
  let emptyLog = true;
  try { emptyLog = fs.statSync(expandHome(cfg.logPath)).size === 0; } catch { /* no log yet */ }

  try {
    const opts: FirewallOptions = { configPath: s.configPath };
    if (PRACTICE) {
      // Buttons in the console fire these as one of the agents. `n` makes a URL new, so the cache does not answer it.
      const at = (i: number, route: string) => `http://127.0.0.1:${PRACTICE_PORTS[i]}${route}`;
      let n = 0;
      const table: Record<string, () => string[]> = {
        buy: () => [at(0, "/good")],
        again: () => [at(0, "/good")],
        dataset: () => [at(1, `/dataset?n=${++n}`)], // its own host, so a blocked first seller does not hide the approval step
        pricey: () => [at(1, "/pricey")],
        swap: () => [at(2, "/switch"), at(2, "/switch-b")],
        loop: () => [at(0, `/good?n=${++n}`)],
        flaky: () => [at(3, "/nodeliver")],
        probe: () => ["http://169.254.169.254/latest/meta-data/"],
      };
      opts.practice = { settlement: ONCHAIN ? "testnet" : "simulated", names: Object.keys(table), urls: (name) => (Object.hasOwn(table, name) ? table[name]!() : []) };
    }
    if (PRACTICE) {
      // The Researcher runs inside this process as one of the owner's agents; every purchase goes through fetchFor.
      const hosts = PRACTICE_PORTS.map((p) => `127.0.0.1:${p}`);
      opts.templates = {
        list: [{ id: "researcher", name: "Researcher", about: "Buys notes on a topic from paid sources and returns them with a receipt." }],
        run: (_template, agent, task, onStep) => {
          const fw = running;
          if (fw === null) return Promise.reject(new Error("not started"));
          return research({ fetch: (u) => fw.firewall.fetchFor(agent, u) }, `http://${hosts[0]}/index`, task, { hosts, onStep });
        },
      };
    }
    running = await startFirewall(cfg, opts);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EADDRINUSE") {
      console.error(`Port ${cfg.listen.port} is already in use. If the firewall is already running, open http://${cfg.listen.host}:${cfg.listen.port}/app`);
      process.exit(1);
    }
    throw e;
  }
  const base = `http://${running.host}:${running.port}`;
  const addr = running.firewall.addresses;

  console.log(s.created ? `First run: settings created in ${s.dir}` : `Settings: ${s.dir}`);
  console.log(`Firewall is running. Console: ${base}/app`);
  console.log("");
  console.log("Wallet the firewall pays from (testnet only):");
  console.log(`  Base Sepolia   ${addr.evm}`);
  if (addr.svm) console.log(`  Solana devnet  ${addr.svm}`);
  console.log("  Free test USDC: https://faucet.circle.com");
  console.log("");
  console.log("Connect an agent (Claude Code):");
  const q = (p: string) => (/^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replaceAll("'", `'\\''`)}'`);
  console.log(`  claude mcp add spend-firewall -e ASF_AGENT_TOKEN_FILE=${q(s.agentTokenPath)} -- node ${q(path.join(ROOT, "src", "mcp.ts"))}`);
  console.log("");

  // The console is signed in through the URL fragment: it is never sent to the server and the page removes it at once.
  const admin = cfg.adminTokenSha256 === undefined ? null : readAdminToken(s.adminTokenPath);
  const adminOk = admin !== null && createHash("sha256").update(admin).digest("hex") === cfg.adminTokenSha256;
  if (cfg.adminTokenSha256 === undefined) console.log("The console is off: this config has no adminTokenSha256 (bench/README.md, Console).");
  else if (!adminOk) console.log(`The console will ask for the admin token (no matching ${path.basename(s.adminTokenPath)} in ${s.dir}).`);
  if (!NO_OPEN && cfg.adminTokenSha256 !== undefined) openBrowser(adminOk ? `${base}/app#k=${admin}` : `${base}/app`);

  if (PRACTICE) {
    const agentHex = Object.keys(cfg.agents);
    let token: string | null = null;
    try { token = fs.readFileSync(s.agentTokenPath, "utf8").trim(); } catch { /* handled below */ }
    if (!token || !agentHex.includes(createHash("sha256").update(token).digest("hex"))) {
      console.log("Practice run skipped: agent.token does not match an agent in this config.");
    } else {
      const seller = loadOrCreateKeys(path.join(dir, "seller-keys"));
      const sellerEnv: NodeJS.ProcessEnv = { ...process.env, SELLER_NETWORKS: "evm", SELLER_EVM: seller.evmAddress, SELLER_EVM_2, SELLER_PORT: String(PRACTICE_PORTS[0]) };
      if (!ONCHAIN) {
        // Local practice facilitator: checks the signed payment, sends nothing to a chain.
        const fp = spawn(process.execPath, ["bench/practice-facilitator.ts"], {
          cwd: ROOT, stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, PRACTICE_FACILITATOR_PORT: String(PRACTICE_BASE) },
        });
        kids.push(fp);
        await waitFor(`http://127.0.0.1:${PRACTICE_BASE}/supported`, 10000);
        sellerEnv["FACILITATOR_URL"] = `http://127.0.0.1:${PRACTICE_BASE}`;
      }
      const sp = spawn(process.execPath, ["bench/seller.ts"], { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"], env: sellerEnv });
      kids.push(sp);
      if (!(await waitFor(`http://127.0.0.1:${PRACTICE_PORTS[0]}/good`, 20000))) {
        console.log(ONCHAIN ? "Practice seller did not start (with --onchain it needs the internet to reach the test facilitator). The firewall keeps running."
          : `Practice seller did not start (are ports ${PRACTICE_BASE}-${PRACTICE_BASE + 4} free?). The firewall keeps running.`);
      } else {
        console.log(ONCHAIN ? "Practice purchases settle on the testnet through the public facilitator; the wallet needs test USDC."
          : "Practice purchases are signed for real and accepted by a practice facilitator on this machine. No money moves.");
        console.log("Practice seller is up. The console has a Practice panel: press its buttons to act as the agent yourself.");
        if (emptyLog) {
          console.log("First time: a demo agent is asking the seller for paid data so the console is not empty.");
          const ag = spawn(process.execPath, ["bench/agent.ts"], {
            cwd: ROOT, stdio: "inherit", env: { ...process.env, AGENT_TOKEN: token, FIREWALL_URL: base, SELLER_PORT: String(PRACTICE_PORTS[0]) },
          });
          kids.push(ag);
          await new Promise((res) => ag.on("exit", res));
          console.log("Demo agent finished.");
        }
      }
    }
  }
  console.log("Press Ctrl+C to stop.");
} catch (e) {
  // Never print config contents; the message names the problem only.
  console.error(`startup failed: ${e instanceof Error ? e.message : "unknown error"}`);
  stop(1);
}
