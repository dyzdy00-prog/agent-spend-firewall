// First-run setup for `npm start`: a private directory with a config, an agent token and an admin token.
// Nothing here prints or returns a secret; tokens live in 0600 files and the config holds only their sha256.
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const FIRST_AGENT = "my-agent";

export interface SetupResult {
  dir: string;
  configPath: string;
  agentTokenPath: string;
  adminTokenPath: string;
  /** true when this call wrote the config; false when one was already there and was left untouched. */
  created: boolean;
}

export function defaultBaseDir(): string {
  return process.env.ASF_DIR ?? path.join(os.homedir(), ".agent-spend-firewall");
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** Reads a token file, or creates it (0600, never overwrites). Refuses a file that group or others can read. */
function tokenFile(file: string): string {
  if (!fs.existsSync(file)) {
    try { fs.writeFileSync(file, randomBytes(32).toString("hex") + "\n", { mode: 0o600, flag: "wx" }); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  const st = fs.statSync(file);
  if ((st.mode & 0o077) !== 0) throw new Error(`${path.basename(file)} must not be readable by group or others`);
  const t = fs.readFileSync(file, "utf8").trim();
  if (t.length < 16) throw new Error(`${path.basename(file)} is empty or too short`);
  return t;
}

/**
 * Makes `dir` usable by the firewall. An existing config.json is never changed.
 * `template` is the parsed bench/config.example.json; `keyDir` is where the firewall keeps its testnet keys.
 */
export function ensureSetup(dir: string, keyDir: string, template: Record<string, any>): SetupResult {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const out: SetupResult = {
    dir,
    configPath: path.join(dir, "config.json"),
    agentTokenPath: path.join(dir, "agent.token"),
    adminTokenPath: path.join(dir, "admin.token"),
    created: false,
  };
  if (fs.existsSync(out.configPath)) return out;

  const agent = tokenFile(out.agentTokenPath);
  const admin = tokenFile(out.adminTokenPath);
  const cfg = structuredClone(template);
  cfg.keyDir = keyDir;
  cfg.storePath = path.join(dir, "state.db");
  cfg.logPath = path.join(dir, "decisions.jsonl");
  cfg.adminTokenSha256 = sha(admin);
  cfg.approve_above_usd = "0.03";
  cfg.allowPrivateHosts = [];
  cfg.agents = { [sha(agent)]: FIRST_AGENT };
  cfg.policy.budget_usd = "0.50";
  cfg.policy.agents = { [FIRST_AGENT]: { budget_usd: "0.25" } };
  try {
    fs.writeFileSync(out.configPath, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    out.created = true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  return out;
}

/** The admin token for the sign-in link, or null when there is no readable private token file. Never throws. */
export function readAdminToken(file: string): string | null {
  try {
    const st = fs.statSync(file);
    if ((st.mode & 0o077) !== 0) return null;
    const t = fs.readFileSync(file, "utf8").trim();
    return /^[0-9a-f]{32,128}$/.test(t) ? t : null;
  } catch { return null; }
}
