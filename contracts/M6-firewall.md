# M6 — Firewall process (FROZEN, MVP)

Files: `src/firewall.ts` (library), `src/server.ts` (entry point: `node src/server.ts <config.json>`). Uses M1–M5 and `@x402/core`, `@x402/evm`, `@x402/svm`.

## Config (`config.json`, never committed; example in `bench/config.example.json`)

```json
{ "listen": { "host": "127.0.0.1", "port": 8402 },
  "keyDir": "~/.agent-spend-firewall/keys",
  "storePath": "~/.agent-spend-firewall/state.db",
  "logPath": "~/.agent-spend-firewall/decisions.jsonl",
  "svmRpcUrl": "https://api.devnet.solana.com",
  "agents": { "<sha256 hex of the agent's bearer token>": "agent-id" },
  "assets": [ /* AssetRule[] */ ],
  "policy": { /* Policy, amounts as decimal strings */ } }
```
`~` is expanded. Startup: `checkPolicy`, `loadOrCreateKeys`, `openStore`; any failure → exit non-zero. Listens on loopback only; a non-loopback `listen.host` → refuse to start.

## API

`POST /fetch` — header `Authorization: Bearer <token>`; body `{ "url": string }` (GET only in MVP).
1. Unknown token → 401 (token compared by sha256 in constant time). Body > 8 KB → 413.
2. `host = hostOf(url)`; null → 400.
3. Firewall fetches `url` itself with `redirect: "manual"`; any 3xx → response `{ status: 502, refused: { code: "HOST", reason: "redirect" } }`. Timeout 15 s. Response body read up to 256 KB.
4. Not 402 → pass through (`paid: null`).
5. 402 → parse with `x402HTTPClient`. Choose the first requirement with scheme `exact`, network in `policy.networks` and asset found by `findAsset`; none → `refused: { code: "NETWORK" | "ASSET", ... }` without signing.
6. Build `ReaderContext`: `payer` = own address for that chain, `host`, `agent`, `now = Math.floor(Date.now()/1000)`, `expected` from the chosen requirement (`amount` as bigint, `maxTimeoutSeconds`), `assets`.
7. Gate = reader (`readEvm` / `readSvm`) → if ok, `store.decideAndRecord(intent, now, view => evaluate(intent, policy, view, now))` → allow returns `signable`. Register **only** the guarded signers (fresh per request, bound to this context) and pay once; retry the request with the payment header.
8. After paying: response status ≥ 400 or no settlement header → `store.markUndelivered(host, now)`.
9. Response JSON: `{ status, paid: { usd6: string, network, payee, tx?: string } | null, refused: { code, reason } | null, body: string }`.

`GET /api/log?limit=N` — last N (≤ 500) decision log entries, newest first. Loopback only, no auth in MVP.
`GET /` — dashboard HTML (M10).

## Decision log (`logPath`, JSONL, append-only)
One line per payment attempt: `{ ts, agent, host, network, asset, amountAtoms, usd6, payee, allow, code?, reason?, delivered?, tx? }`. Never keys, signatures, tokens, URLs with path or query, or bodies. amounts as strings.

## Required tests
Uses a local fake seller (node:http) that returns hand-built x402 v2 `PAYMENT-REQUIRED` responses, so no network or funds are needed: unknown token 401; non-loopback listen refused; redirect refused; requirement on unsupported network refused before any signing; CAP / PAYEE / BUDGET refusals logged and nothing signed; allowed payment produces a payment header the fake seller can decode, whose signed values match the requirement; seller replying 500 after payment → undelivered recorded, next call to that host refused with UNDELIVERED once the threshold is reached; log lines contain no token, key or URL path.

## Amendment 2026-11-18 (#8, #15)

- Outbound requests go through `src/netguard.ts`: the resolved address of every connection is checked inside the connection's own DNS lookup; loopback, private, link-local, CGNAT, documentation, multicast, reserved and unspecified IPv4/IPv6 addresses (and IPv4-mapped forms) are refused with `HOST` / "private or internal address" before any contact. Config `allowPrivateHosts: string[]` (exact `host:port` as `hostOf` returns) exempts the local bench only.
- When a paid request is not settled, the log keeps the seller's or facilitator's short reason in `sellerError` (from the PAYMENT-REQUIRED `error` field or the PAYMENT-RESPONSE `errorReason`).
- A signed authorization that was not settled stays counted against the budget: the seller holds it and could still submit it until it expires.
