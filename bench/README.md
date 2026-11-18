# Bench: seller, demo agent, config

Testnets only. Never put a mainnet key or real funds anywhere near this.

## 1. Token and its hash

The firewall config stores only the sha256 of the agent token. One command makes both:

```
node -e 'const t=require("crypto").randomBytes(24).toString("hex");console.log("TOKEN="+t);console.log("HASH="+require("crypto").createHash("sha256").update(t).digest("hex"))'
```

Copy `bench/config.example.json` to a private path (not committed), replace
`REPLACE_WITH_SHA256_HEX_OF_THE_TOKEN` with `HASH`, and keep `TOKEN` for the agent (`AGENT_TOKEN`).
The example policy: cap $0.05 per payment, budget $0.10 per 3600 s, max validity 600 s,
a host is refused after 2 undelivered paid requests per 3600 s, `payees` empty so the first payee seen per host is pinned.

## 2. Fund the payer with test USDC

Start the firewall once (step 4); it creates its keys under `keyDir` and prints/logs its addresses
(see the M6 startup output). Then get free test USDC for those addresses from the Circle faucet
(https://faucet.circle.com): Base Sepolia for the EVM address, Solana Devnet for the Solana address.
The EVM payer pays no gas (EIP-3009 authorization, the facilitator settles); the Solana fee payer is the facilitator.
The seller needs two EVM receiving addresses (`SELLER_EVM`, `SELLER_EVM_2`) and one Solana address (`SELLER_SVM`);
public addresses only, any wallet you own, no keys are given to the seller.

## 3. Seller

```
SELLER_EVM=0x... SELLER_EVM_2=0x... SELLER_SVM=<base58> node bench/seller.ts
```

Listens on `127.0.0.1:4021` (override `SELLER_PORT`), facilitator `https://x402.org/facilitator` (override `FACILITATOR_URL`).

## 4. Firewall and agent

```
node src/server.ts /path/to/your-config.json      # dashboard at http://127.0.0.1:8402/
AGENT_TOKEN=<TOKEN> node bench/agent.ts
```

## What each scenario shows

| Route | Price | Expected |
|---|---|---|
| `/good` x3 | $0.01 | ALLOWED, delivered |
| `/pricey` | $5.00 | REFUSED CAP, nothing signed |
| `/switch`, then `/switch-b` | $0.01 | same host: first ALLOWED (payee pinned), second REFUSED PAYEE (payTo is `SELLER_EVM_2`) |
| `/nodeliver` x3 | $0.01 | seller verifies payment then returns 500, no settlement: first two ALLOWED but undelivered, third REFUSED UNDELIVERED |
| `/good` burst | $0.01 | ALLOWED until the $0.10 hour budget is reached, then REFUSED BUDGET |

Exact counts depend on which payments were recorded; to repeat the demo, wait out the window or point `storePath` and `logPath` at fresh files.
The dashboard (`/`) shows the same decisions with explorer links for settled transactions.
