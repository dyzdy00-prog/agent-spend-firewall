# M10 dashboard and M11 test bench (FROZEN, MVP)

## M10 — `src/dashboard.html` (served by M6 at `GET /`)
One self-contained HTML file, no external requests. Polls `/api/log?limit=200` every 2 s. Shows: spent in window vs budget (from log, allows only), counts allowed / refused, a table (time, agent, host, network, amount in USD, payee shortened, ALLOWED / REFUSED code + reason, delivered, explorer link for `tx`: Base Sepolia `https://sepolia.basescan.org/tx/<tx>`, Solana devnet `https://explorer.solana.com/tx/<tx>?cluster=devnet`). Text from the log is inserted with `textContent`, never `innerHTML`. Works at 375 px width.

## M11 — `bench/`
- `bench/seller.ts` — local x402 seller (`@x402/express`, facilitator `https://x402.org/facilitator`) on `127.0.0.1:4021`, payTo from env `SELLER_EVM` / `SELLER_SVM`, networks Base Sepolia `eip155:84532` and Solana devnet. Routes:
  - `/good` — $0.01, returns a small JSON;
  - `/pricey` — $5.00 (demo: CAP refusal);
  - `/switch` — $0.01, payTo alternates between `SELLER_EVM` and `SELLER_EVM_2` on each request (demo: pinned payee → PAYEE refusal);
  - `/nodeliver` — $0.01, payment verified then handler returns 500 (demo: UNDELIVERED);
  The seller holds no keys.
- `bench/agent.ts` — demo agent: calls the firewall `POST /fetch` with its token for a fixed scenario list (good ×3, pricey, switch ×2, nodeliver ×3, good burst until BUDGET) and prints one line per call: route → ALLOWED $x / REFUSED CODE.
- `bench/config.example.json` — M6 config for the bench (small budget, e.g. $0.10 per hour, cap $0.05).
- `bench/README.md` — how to run, how to fund the payer with test USDC (Circle faucet), what each scenario shows.
