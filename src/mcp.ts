// M7 MCP interface. Contract: contracts/M7-mcp.md.
// One tool for the agent. Holds only the agent's bearer token, never a key. stdout = JSON-RPC only.
import fs from "node:fs";
import readline from "node:readline";

const VERSION = "0.1.0";
const SUPPORTED = ["2025-06-18", "2025-03-26", "2024-11-05"];
const BODY_MAX = 16_000;

function die(msg: string): never {
  process.stderr.write(`agent-spend-firewall mcp: ${msg}\n`);
  process.exit(1);
}

function firewallUrl(): string {
  const raw = process.env.ASF_FIREWALL_URL ?? "http://127.0.0.1:8402";
  let u: URL;
  try { u = new URL(raw); } catch { die("ASF_FIREWALL_URL is not a URL"); }
  const h = u.hostname;
  const loop = h === "localhost" || h === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
  if (u.protocol !== "http:" || !loop) die("ASF_FIREWALL_URL must be a loopback http URL");
  return u.origin;
}

function readToken(): string {
  const p = process.env.ASF_AGENT_TOKEN_FILE;
  if (!p) die("ASF_AGENT_TOKEN_FILE is not set");
  let st: fs.Stats;
  try { st = fs.statSync(p); } catch { die("token file not readable"); }
  if ((st.mode & 0o077) !== 0) die("token file must not be readable by group or others");
  const t = fs.readFileSync(p, "utf8").trim();
  if (!t) die("token file is empty");
  return t;
}

const FIREWALL = firewallUrl();
const TOKEN = readToken();

const TOOL = {
  name: "fetch_paid_resource",
  description:
    "Fetch an http(s) URL. If the server asks for an x402 payment, the owner's spend firewall decides whether to pay " +
    "(per-payment cap, budget, payee and delivery rules) and signs it; you never hold a key. A refusal is final for this " +
    "request: report it, do not try to work around it.",
  inputSchema: {
    type: "object",
    properties: { url: { type: "string", description: "Absolute http or https URL" } },
    required: ["url"],
    additionalProperties: false,
  },
};

type Id = string | number | null;
interface FetchResult {
  status: number;
  paid: { usd6: string; network: string; payee: string; tx?: string } | null;
  refused: { code: string; reason: string } | null;
  body: string;
}

function send(msg: unknown): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
}
const ok = (id: Id, result: unknown) => send({ jsonrpc: "2.0", id, result });
const err = (id: Id, code: number, message: string) => send({ jsonrpc: "2.0", id, error: { code, message } });

function usd(usd6: string): string {
  const n = BigInt(usd6);
  return `$${n / 1_000_000n}.${(n % 1_000_000n).toString().padStart(6, "0")}`;
}

async function callTool(url: string): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
  let r: Response;
  try {
    r = await fetch(`${FIREWALL}/fetch`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    return { content: [{ type: "text", text: "Spend firewall is not reachable." }], isError: true };
  }
  if (r.status !== 200) {
    return { content: [{ type: "text", text: `Spend firewall answered HTTP ${r.status}.` }], isError: true };
  }
  const j = (await r.json()) as FetchResult;
  let line: string;
  if (j.refused) line = `REFUSED ${j.refused.code}: ${j.refused.reason}`;
  else if (j.paid) line = `PAID ${usd(j.paid.usd6)} on ${j.paid.network}${j.paid.tx ? ` (tx ${j.paid.tx})` : ""}`;
  else line = "NO PAYMENT NEEDED";
  const body = j.body.length > BODY_MAX ? j.body.slice(0, BODY_MAX) + "\n[truncated]" : j.body;
  return { content: [{ type: "text", text: `${line}\nupstream status ${j.status}\n\n${body}` }] };
}

async function handle(msg: { id?: Id; method?: unknown; params?: unknown }): Promise<void> {
  const id = msg.id ?? null;
  const isRequest = msg.id !== undefined;
  const params = (msg.params ?? {}) as Record<string, unknown>;
  switch (msg.method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      return ok(id, {
        protocolVersion: SUPPORTED.includes(asked) ? asked : SUPPORTED[0],
        capabilities: { tools: {} },
        serverInfo: { name: "agent-spend-firewall", version: VERSION },
      });
    }
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, { tools: [TOOL] });
    case "tools/call": {
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      if (params.name !== TOOL.name) return err(id, -32602, "unknown tool");
      if (typeof args.url !== "string" || args.url === "") return err(id, -32602, "url is required");
      return ok(id, await callTool(args.url));
    }
    default:
      if (isRequest) err(id, -32601, "method not found");
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg: unknown;
  try { msg = JSON.parse(line); } catch { return err(null, -32700, "parse error"); }
  if (typeof msg !== "object" || msg === null || Array.isArray(msg)) return err(null, -32600, "invalid request");
  handle(msg as { id?: Id; method?: unknown; params?: unknown }).catch(() => {
    const id = (msg as { id?: Id }).id;
    if (id !== undefined) err(id, -32603, "internal error");
  });
});
