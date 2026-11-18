// Demo agent: asks the firewall to fetch bench-seller URLs and prints what happened. Holds no keys.
// Run: AGENT_TOKEN=<token> node bench/agent.ts
const FIREWALL = process.env.FIREWALL_URL ?? "http://127.0.0.1:8402";
const BASE_PORT = Number(process.env.SELLER_PORT ?? 4021);
// Each scenario on its own seller port (= its own host for the firewall), see bench/seller.ts.
const PORT_OF: Record<string, number> = { "/good": 0, "/pricey": 1, "/switch": 2, "/switch-b": 2, "/nodeliver": 3 };
const sellerUrl = (route: string) => `http://127.0.0.1:${BASE_PORT + (PORT_OF[route] ?? 0)}${route}`;
const TOKEN = process.env.AGENT_TOKEN;
if (!TOKEN) {
  console.error("set AGENT_TOKEN (see bench/README.md)");
  process.exit(1);
}

interface FetchResult {
  status: number;
  paid: { usd6: string; network: string; payee: string; tx?: string } | null;
  refused: { code: string; reason: string } | null;
  body: string;
}

const scenario: string[] = [
  "/good", "/good", "/good",
  "/pricey",
  "/switch", "/switch-b",
  "/nodeliver", "/nodeliver", "/nodeliver",
];
const BURST_MAX = 12;

function usd(usd6: string): string {
  const n = BigInt(usd6);
  return `$${(n / 1_000_000n).toString()}.${(n % 1_000_000n).toString().padStart(6, "0")}`;
}

async function call(route: string): Promise<FetchResult | null> {
  try {
    const r = await fetch(`${FIREWALL}/fetch`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ url: sellerUrl(route) }),
    });
    if (!r.ok) {
      console.log(`${route.padEnd(11)} -> firewall HTTP ${r.status}`);
      return null;
    }
    return (await r.json()) as FetchResult;
  } catch (e) {
    console.log(`${route.padEnd(11)} -> firewall unreachable (${(e as Error).message})`);
    return null;
  }
}

function line(route: string, r: FetchResult): void {
  if (r.refused) console.log(`${route.padEnd(11)} -> REFUSED ${r.refused.code}  (${r.refused.reason})`);
  else if (r.paid) console.log(`${route.padEnd(11)} -> ALLOWED ${usd(r.paid.usd6)}  upstream ${r.status}`);
  else console.log(`${route.padEnd(11)} -> no payment, upstream ${r.status}`);
}

for (const route of scenario) {
  const r = await call(route);
  if (!r) process.exit(1);
  line(route, r);
}
console.log("-- burst on /good until the budget stops it --");
for (let i = 0; i < BURST_MAX; i++) {
  const r = await call("/good");
  if (!r) process.exit(1);
  line("/good", r);
  if (r.refused?.code === "BUDGET" || r.refused?.code === "AGENT_BUDGET") break;
}
