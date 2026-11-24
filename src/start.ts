// One command: `npm start`. Sets up on first run, starts the firewall and opens the owner console signed in.
//   npm start                 firewall + console
//   npm start -- --practice   also a local practice seller and one run of the demo agent, so the console has real decisions in it
//   npm start -- --practice --onchain   practice purchases settle on the testnet through the public facilitator (needs test USDC)
//   npm start -- --no-open    do not open a browser
// Testnets only. Prints no key and no token.
import { readNotes } from "../agents/reader.ts";
import { buy, catalogOffers, emptyBrief, research, type Brief } from "../agents/researcher.ts";
import { emptyShop, shop, shopFrom, type ShopBrief } from "../agents/shopper.ts";
import { emptyWatch, parseWatch, specOpts, watch, type WatchBrief } from "../agents/watcher.ts";
import { load as loadCatalog, refresh as refreshCatalog, search as searchCatalog, type CatalogEntry } from "./catalog.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expandHome, loadConfig, maxUsd6Of, startFirewall, type FirewallOptions, type RunningFirewall } from "./firewall.ts";
import { defaultKeyDir, loadOrCreateKeys } from "./keys.ts";
import { defaultBaseDir, ensureSetup, readAdminToken } from "./setup.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRACTICE = process.argv.includes("--practice");
const NO_OPEN = process.argv.includes("--no-open");
const ONCHAIN = process.argv.includes("--onchain");
// Practice processes: the facilitator on the base port, seven seller hosts after it (the last three are used by the ready-made agents only).
const PRACTICE_BASE = Number(process.env.ASF_PRACTICE_PORT ?? 4020);
const PRACTICE_PORTS = [1, 2, 3, 4, 5, 6, 7].map((i) => PRACTICE_BASE + i);
const SELLER_EVM_2 = "0x000000000000000000000000000000000000dEaD";
// The live Researcher buys on these only, whatever else the policy allows.
const TESTNETS = ["eip155:84532", "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"];
const CATALOG_MAX_AGE_MS = 24 * 3600 * 1000;
const LIVE_SOURCES = 4;

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
    const opts: FirewallOptions = { configPath: s.configPath, connect: { agentTokenFile: s.agentTokenPath, mcpPath: path.join(ROOT, "src", "mcp.ts") } };
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
        raise: () => { const k = ++n; return [at(0, `/tariff?p=1&n=${k}`), at(0, `/tariff?p=2&n=${k}`)]; }, // one address, $0.01 and then $0.02
        probe: () => ["http://169.254.169.254/latest/meta-data/"],
      };
      opts.practice = { settlement: ONCHAIN ? "testnet" : "simulated", names: Object.keys(table), urls: (name) => (Object.hasOwn(table, name) ? table[name]!() : []) };
    }
    {
      // The Researcher runs inside this process as one of the owner's agents; every purchase goes through fetchFor.
      // "researcher" buys filler notes from the practice seller; "researcher-live" buys from sellers in the public
      // x402 catalog that accept a testnet. Either way a model reads the notes afterwards if the owner set a key.
      const hosts = PRACTICE_PORTS.map((p) => `127.0.0.1:${p}`);
      let cat: { entries: CatalogEntry[]; fetchedAt: number } | null = null;
      const liveOffers = async (task: string) => {
        if (cat === null) cat = loadCatalog(cfg.catalogDir);
        if (cat === null || Date.now() - cat.fetchedAt > CATALOG_MAX_AGE_MS) {
          try { await refreshCatalog(cfg.catalogDir); } catch { /* offline: an older catalog is still usable */ }
          cat = loadCatalog(cfg.catalogDir) ?? cat;
        }
        if (cat === null || cat.entries.length === 0) return null;
        const entries = cat.entries;
        const nets = cfg.policy.networks.filter((n) => TESTNETS.includes(n));
        return catalogOffers(task, (word) => nets.flatMap((network) =>
          searchCatalog(entries, word, { network, maxUsd: cfg.policy.cap_usd, limit: 500 }).flatMap((e) => {
            const o = e.offers.find((x) => x.scheme === "exact" && x.usd !== undefined);
            return o === undefined ? [] : [{ url: e.url, description: e.description, usd: o.usd! }];
          })), LIVE_SOURCES);
      };
      // Ids are <agent> or <agent>-live; the console reads the agent and the source from the id.
      const list = [
        { id: "researcher-live", name: "Researcher, live sellers (testnet)", about: "Buys from sellers in the public x402 catalog that accept test money." },
        { id: "shopper-live", name: "Shopper, live sellers (testnet)", about: "Tries the cheapest matching testnet seller first and stops at the first delivery." },
        { id: "watcher-live", name: "Watcher, live sellers (testnet)", about: "Buys the first matching testnet seller's answer again each run and says whether it changed." },
      ];
      // What each watch saw last: a fingerprint per agent, source and task. Kept next to the state file.
      const watchFile = path.join(path.dirname(cfg.storePath), "watch.json");
      const readWatch = (): Record<string, { fp: string; at: number }> => {
        try { const v = JSON.parse(fs.readFileSync(watchFile, "utf8")); return typeof v === "object" && v !== null && !Array.isArray(v) ? v : {}; } catch { return {}; }
      };
      const lastSeen = (key: string): string | null => {
        const e = readWatch()[key];
        return e !== undefined && typeof e.fp === "string" && /^([0-9a-f]{16}|ref:-?[0-9]{1,15}(\.[0-9]{1,12})?(e-?[0-9]{1,3})?)$/.test(e.fp) ? e.fp : null;
      };
      const remember = (key: string, fp: string) => {
        const all = readWatch();
        all[key] = { fp, at: Math.floor(Date.now() / 1000) };
        const keys = Object.keys(all).sort((a, b) => (all[b]!.at ?? 0) - (all[a]!.at ?? 0)).slice(0, 200);
        const kept: Record<string, { fp: string; at: number }> = {};
        for (const k of keys) kept[k] = all[k]!;
        try { fs.writeFileSync(watchFile, JSON.stringify(kept), { mode: 0o600 }); } catch { /* the next run is a first look again */ }
      };
      if (PRACTICE) list.unshift(
        { id: "researcher", name: "Researcher, practice sellers", about: "Buys filler notes from the practice seller on this machine." },
        { id: "shopper", name: "Shopper, practice sellers", about: "Compares four practice listings of one item and buys the cheapest that delivers." },
        { id: "watcher", name: "Watcher, practice sellers", about: "Buys a practice reading that changes every minute and says whether it changed." },
      );
      opts.templates = {
        list,
        forget: (template, agent, task) => {
          const all = readWatch(), key = [agent, template, task].join("\u0000");
          if (!(key in all)) return;
          delete all[key];
          try { fs.writeFileSync(watchFile, JSON.stringify(all), { mode: 0o600 }); } catch { /* it is overwritten by the next look */ }
        },
        run: async (template, agent, task, onStep) => {
          const fw = running;
          if (fw === null) throw new Error("not started");
          // A listing's price is the agent's ceiling: a seller that asks more than it listed is refused before signing.
          const client = { fetch: (u: string, maxUsd?: string, fresh?: boolean) => { const m = maxUsd === undefined ? null : maxUsd6Of(maxUsd); return fw.firewall.fetchFor(agent, u, { ...(m === null ? {} : { maxUsd6: m }), ...(fresh === true ? { fresh: true } : {}) }); } };
          let brief: Brief | ShopBrief | WatchBrief;
          if (template === "watcher" || template === "watcher-live") {
            const key = [agent, template, task].join("\u0000");
            let w: WatchBrief;
            const spec = parseWatch(task);
            let said = "";
            const onWatchStep = (s: Parameters<typeof onStep>[0]) => { if (s.kind === "changed") said = s.detail; onStep(s); };
            if (template === "watcher") {
              w = await watch(client, { url: `http://${hosts[0]}/feed?topic=${encodeURIComponent(spec.topic)}`, title: "Feed", usd: "0.01" }, task, lastSeen(key), { onStep: onWatchStep, ...specOpts(spec) });
            } else {
              const offers = await liveOffers(spec.topic);
              w = offers === null ? emptyWatch(task, "the public x402 catalogs could not be downloaded")
                : offers.length === 0 ? emptyWatch(task, "no testnet seller in the catalog mentions these words under the per-payment cap")
                : await watch(client, offers[0]!, task, lastSeen(key), { onStep: onWatchStep, holdToListing: false, ...specOpts(spec) });
            }
            if (w.fingerprint !== undefined) remember(key, w.fingerprint);
            if (w.receipt.changed > 0) fw.firewall.alerts.event({ type: "changed", agent, task: spec.topic, ...(spec.field !== undefined && said !== "" ? { detail: said } : {}) });
            return w;
          }
          if (template === "researcher") brief = await research(client, `http://${hosts[0]}/index`, task, { hosts, onStep });
          else if (template === "shopper") brief = await shopFrom(client, `http://${hosts[0]}/quotes`, task, { hosts, onStep });
          else if (template === "shopper-live") {
            const offers = await liveOffers(task);
            brief = offers === null ? emptyShop(task, "the public x402 catalogs could not be downloaded")
              : offers.length === 0 ? emptyShop(task, "no testnet seller in the catalog mentions these words under the per-payment cap")
              : await shop(client, offers, task, { onStep, holdToListing: false });
          } else {
            const offers = await liveOffers(task);
            brief = offers === null ? emptyBrief(task, "the public x402 catalogs could not be downloaded")
              : offers.length === 0 ? emptyBrief(task, "no testnet seller in the catalog mentions these words under the per-payment cap")
              : await buy(client, offers, task, { onStep, maxSources: LIVE_SOURCES, holdToListing: false });
          }
          const key = fw.firewall.readerKey.get();
          const reading = brief.notes.length === 0 ? null : key === null ? { off: true } : await readNotes(task, brief.notes, { apiKey: key });
          return { ...brief, reading };
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
          : `Practice seller did not start (are ports ${PRACTICE_BASE}-${PRACTICE_BASE + PRACTICE_PORTS.length} free?). The firewall keeps running.`);
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
