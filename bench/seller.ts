// Local x402 seller for the bench. Holds no keys: only public payee addresses from the environment.
// Run: SELLER_EVM=0x... SELLER_EVM_2=0x... SELLER_SVM=<base58> node bench/seller.ts
// express ships no types here (transitive dependency of @x402/express); loosely typed on purpose.
// @ts-ignore
import express from "express";
import { paymentMiddlewareFromConfig } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import type { RoutesConfig } from "@x402/core/server";
import type { Network } from "@x402/core/types";

interface Res { json(b: unknown): void; status(c: number): Res }

const EVM_NET: Network = "eip155:84532";
const SVM_NET: Network = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const FACILITATOR = process.env.FACILITATOR_URL ?? "https://x402.org/facilitator";
const PORT = Number(process.env.SELLER_PORT ?? 4021);

function need(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`missing env ${name}`);
    process.exit(1);
  }
  return v;
}
// SELLER_NETWORKS: evm, svm or evm,svm (default both). Only the chosen networks get routes and scheme registrations.
const NETS = (process.env.SELLER_NETWORKS ?? "evm,svm").split(",").map((s) => s.trim()).filter(Boolean);
for (const n of NETS) {
  if (n !== "evm" && n !== "svm") {
    console.error(`bad SELLER_NETWORKS entry: ${n}`);
    process.exit(1);
  }
}
const useEvm = NETS.includes("evm");
const useSvm = NETS.includes("svm");
if (!useEvm && !useSvm) {
  console.error("SELLER_NETWORKS selects no network");
  process.exit(1);
}
const evm1 = useEvm ? need("SELLER_EVM") : "";
const evm2 = useEvm ? need("SELLER_EVM_2") : "";
const svm = useSvm ? need("SELLER_SVM") : "";

function route(price: string, description: string, dynamicEvm?: () => string) {
  return {
    accepts: [
      ...(useEvm ? [{ scheme: "exact", network: EVM_NET, price, payTo: dynamicEvm ? () => dynamicEvm() : evm1 }] : []),
      ...(useSvm ? [{ scheme: "exact", network: SVM_NET, price, payTo: svm }] : []),
    ],
    description,
    mimeType: "application/json",
  };
}

const routes: RoutesConfig = {
  "GET /good": route("$0.01", "bench: cheap, delivered"),
  "GET /dataset": route("$0.04", "bench: larger purchase (demo: owner approval)"),
  "GET /pricey": route("$5.00", "bench: over the cap"),
  "GET /switch": route("$0.01", "bench: payee A"),
  "GET /switch-b": route("$0.01", "bench: same host, payee B (demo: pinned payee)", () => evm2),
  "GET /nodeliver": route("$0.01", "bench: verified, then 500"),
  // Notes for the Researcher agent (agents/researcher.ts). /index lists them and is free.
  "GET /note/a": route("$0.01", "practice note: background"),
  "GET /note/b": route("$0.02", "practice note: numbers and dates"),
  "GET /note/c": route("$0.01", "practice note: the other view"),
  "GET /note/premium": route("$5.00", "practice note: advertised at $0.02 in the index, asks $5.00"),
  "GET /note/lost": route("$0.01", "practice note: verified, then 500"),
};

const app = express();
app.use(
  paymentMiddlewareFromConfig(
    routes,
    new HTTPFacilitatorClient({ url: FACILITATOR }),
    [
      ...(useEvm ? [{ network: EVM_NET, server: new ExactEvmScheme() }] : []),
      ...(useSvm ? [{ network: SVM_NET, server: new ExactSvmScheme() }] : []),
    ],
  ),
);

app.get("/good", (_req: unknown, res: Res) => {
  res.json({ ok: true, item: "good", at: new Date().toISOString() });
});
app.get("/dataset", (_req: unknown, res: Res) => {
  res.json({ ok: true, item: "dataset", rows: 1000 });
});
app.get("/pricey", (_req: unknown, res: Res) => {
  res.json({ ok: true, item: "pricey" });
});
app.get("/switch", (_req: unknown, res: Res) => {
  res.json({ ok: true, item: "switch" });
});
app.get("/switch-b", (_req: unknown, res: Res) => {
  res.json({ ok: true, item: "switch-b" });
});
app.get("/nodeliver", (_req: unknown, res: Res) => {
  res.status(500).json({ ok: false, error: "seller failed after payment verification" });
});

// Notes are filler that says so: the practice run shows the buying and the receipt, not research.
interface Req { query?: Record<string, unknown> }
const topicOf = (req: Req): string => String(req.query?.["topic"] ?? "").replace(/[^\p{L}\p{N} .,'-]/gu, " ").trim().slice(0, 200) || "your topic";
const note = (title: string, text: (t: string) => string) => (req: Req, res: Res) => { res.json({ title, text: text(topicOf(req)) }); };
app.get("/index", (req: Req, res: Res) => {
  const q = `?topic=${encodeURIComponent(topicOf(req))}`;
  const at = (i: number, p: string) => `http://127.0.0.1:${PORT + i}${p}${q}`;
  res.json({ offers: [
    { url: at(0, "/note/a"), title: "Background", usd: "0.01" },
    { url: at(0, "/note/b"), title: "Numbers and dates", usd: "0.02" },
    { url: at(1, "/note/premium"), title: "Premium analysis", usd: "0.02" },
    { url: at(0, "/note/c"), title: "The other view", usd: "0.01" },
    { url: at(4, "/note/lost"), title: "Field report", usd: "0.01" }, // its own port: its block must not hide the Practice panel's flaky seller
  ] });
});
app.get("/note/a", note("Background", (t) => `Practice note on "${t}": where the subject comes from and who the main actors are. Filler text from the local practice seller.`));
app.get("/note/b", note("Numbers and dates", (t) => `Practice note on "${t}": the figures and the timeline a reader would check first. Filler text from the local practice seller.`));
app.get("/note/c", note("The other view", (t) => `Practice note on "${t}": the strongest argument against the common reading. Filler text from the local practice seller.`));
app.get("/note/premium", note("Premium analysis", (t) => `Practice note on "${t}": never reached, the price is over the cap.`));
app.get("/note/lost", (_req: unknown, res: Res) => {
  res.status(500).json({ ok: false, error: "seller failed after payment verification" });
});

// One port per scenario: the firewall keys pins, budgets and non-delivery blocks by host:port,
// so separate ports keep one scenario's block from hiding the next one.
for (let p = PORT; p < PORT + 5; p++) {
  app.listen(p, "127.0.0.1", () => console.log(`bench seller on http://127.0.0.1:${p} (facilitator ${FACILITATOR})`));
}
