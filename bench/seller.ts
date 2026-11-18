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
const evm1 = need("SELLER_EVM");
const evm2 = need("SELLER_EVM_2");
const svm = need("SELLER_SVM");

function route(price: string, description: string, dynamicEvm?: () => string) {
  return {
    accepts: [
      { scheme: "exact", network: EVM_NET, price, payTo: dynamicEvm ? () => dynamicEvm() : evm1 },
      { scheme: "exact", network: SVM_NET, price, payTo: svm },
    ],
    description,
    mimeType: "application/json",
  };
}

const routes: RoutesConfig = {
  "GET /good": route("$0.01", "bench: cheap, delivered"),
  "GET /pricey": route("$5.00", "bench: over the cap"),
  "GET /switch": route("$0.01", "bench: payee A"),
  "GET /switch-b": route("$0.01", "bench: same host, payee B (demo: pinned payee)", () => evm2),
  "GET /nodeliver": route("$0.01", "bench: verified, then 500"),
};

const app = express();
app.use(
  paymentMiddlewareFromConfig(
    routes,
    new HTTPFacilitatorClient({ url: FACILITATOR }),
    [
      { network: EVM_NET, server: new ExactEvmScheme() },
      { network: SVM_NET, server: new ExactSvmScheme() },
    ],
  ),
);

app.get("/good", (_req: unknown, res: Res) => {
  res.json({ ok: true, item: "good", at: new Date().toISOString() });
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

// One port per scenario: the firewall keys pins, budgets and non-delivery blocks by host:port,
// so separate ports keep one scenario's block from hiding the next one.
for (let p = PORT; p < PORT + 4; p++) {
  app.listen(p, "127.0.0.1", () => console.log(`bench seller on http://127.0.0.1:${p} (facilitator ${FACILITATOR})`));
}
