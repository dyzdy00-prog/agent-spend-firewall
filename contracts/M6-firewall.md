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

## Amendment 2026-11-18 (catalog: price check and search)

- Config (top level, optional): `catalogDir` (default: the directory of `storePath`; `~` expanded) and `max_price_vs_catalog` (number >= 1; absent = no price check). The firewall calls `catalog.load(catalogDir)` at start (no network; a missing file is fine) and re-loads when `catalog.json`'s mtime changes, checking the file at most every 60 s (`FirewallOptions.catalogCheckMs` shortens this for tests). It never refreshes the catalog; the owner runs `node src/catalog.ts refresh`.
- One purchase for requests that overlap: while the cache is on (`cache_ttl_s > 0`), a request for a paid URL that is already being bought waits for that purchase and is answered from the cache if it was delivered; if it was not, the next request in line buys. The wait starts only after the seller answered 402, so free pages are never queued. Scope: per agent, or across agents when `share_cache` is true.
- `GET /report` carries `limits` for the asking agent: `{ paused, capUsd6, askAboveUsd6 | null, windowLeftUsd6, dayLeftUsd6 | null, canPayUsd6 }`. `capUsd6` is the lower of the owner's and the agent's per-payment limit; `windowLeftUsd6` the lower of what is left in the agent's budget and in the shared budget; `dayLeftUsd6` the lower of what is left in the daily limits that are set (null when none is); `canPayUsd6` the lowest of the three, `"0"` while paused. All read from the state store, the same counters the policy decides on, and always for the current budget window whatever `window_s` the report was asked for. Seller-specific rules (payee, new seller, price memory, host budget) are not part of it.
- Stop switch: config `paused` (top level, boolean, default false). While true, a request that would need a payment is refused with `PAUSED` (`payments are paused by the owner`) before any price check, policy decision or signature; free pages and cached answers are unaffected. `Firewall.setPaused(on)` flips it and, when turning it on, settles every payment waiting for approval as refused (`PAUSED`, reserved spend released); it returns how many. A payment that passed the first check and is paused before it is signed is released and refused the same way. `PAUSED` refusals send no owner alert.
- Daily limits: `policy.daily_budget_usd` and `policy.agents[id].daily_budget_usd` (both optional decimals above 0) are read from the config and enforced by M1 rule 15. `Firewall.spentDay(agent?)` returns what was signed in the last 24 hours. With alerts on, the payment that takes an agent to 80% of its own daily limit sends one `budget` event with `daily: true`.
- Shared purchases: config `share_cache` (top level, boolean, default false). When true, a cached purchase answers the same URL for the owner's other agents; the result carries `cached.from` and the log line `cachedFrom` with the agent that paid. An agent whose rule has a `hosts` list that excludes the host gets no shared answer.
- Price memory: config `max_price_jump` (top level, optional, number 1 to 1000). After the catalog check and before the gate, if the store remembers a delivered price for this host and path (query ignored) and the quote is more than `max_price_jump` times that price, the request is refused with `PRICE_JUMP` and nothing is signed. A delivered purchase records its price; an undelivered one does not.
- Delivery: a settled payment answered with a status below 400 and an empty body (whitespace only) counts as not delivered: the host gets an undelivered mark and the log line carries `delivered: false, sellerError: "empty_response"`.
- A delivered purchase marks the host as having delivered (`markDelivered`), which lifts `new_seller_cap_usd` for it.
- Price check: after the requirement is chosen and before the gate (so before any signing), if `max_price_vs_catalog` is set and `catalog.lookup` knows the URL, `catalog.priceCheck(entry, live, maxRatio)` runs. Overpriced -> refusal code `OVERPRICED` (new `RefusalCode`), reason `asks Nx the catalog price` (ratio rounded; integer from 10, one decimal below; no policy numbers; a catalog price of 0 gives `asks more than the catalog price (listed as free)`), logged like other refusals, nothing signed. No known offer on the same network and asset, or an unknown URL: passes as before. A changed payee versus the catalog is not refused (pinning and the allowlist cover it); the log line (refusal or payment) gets `catalogPayeeChanged: true`.
- `GET /search?q=&max_usd=&network=&limit=` (bearer token as `/fetch`; 401 otherwise). `q` required (non-empty, <= 200 chars) else 400; `max_usd` a decimal with <= 6 fraction digits, `limit` a positive integer (default 10, capped at 25), bad values 400; 503 `{"error":"no catalog"}` when none is loaded. Answer: `{ fetchedAt, total, results: [{ url, description, source, offers: [{ network, asset, usd|null, payTo }] (max 3, cheapest first), payable }] }`. `total` counts all matches before `limit`. `payable` = some offer is scheme `exact`, on a network in `policy.networks`, with an asset in `assets`. Descriptions are untrusted: data only, cut to 200 chars. Search contacts no seller and writes no log line.

## Amendment 2026-11-18 (savings and accounting)

- Config `cache_ttl_s` (top level, integer 0..30 days, default 0 = off). When a paid request was delivered (status < 400, settled), the firewall keeps `{status, body}` in memory under (agent id, full URL) for `cache_ttl_s` seconds (max 500 entries, oldest evicted; body already capped at 256 KB). The cache is per process and is lost on restart.
- A later `/fetch` of the same URL by the same agent inside the TTL answers without contacting the seller or signing: `{ status, paid: null, refused: null, body, cached: { usd6, ageS } }` (`usd6` = what the first fetch cost). Log line: `{ ts, agent, host, network, asset, payee, usd6, allow: true, cached: true }` (no URL path, no `amountAtoms`). Refusals, undelivered and free (unpaid) responses are never cached. Another agent never sees an entry.
- `GET /report?window_s=N` — bearer token like `/fetch` (401 otherwise); default N = `policy.window_s`, values above 30 days are clamped, non-integer or < 1 → 400. Computed from the decision log for THAT agent only: `{ windowS, budgetUsd6, spentUsd6, remainingUsd6, paid, delivered, undelivered, refused: { count, byCode }, cached: { count, savedUsd6 }, bySeller[] (top 20 by paidUsd6) }`, money as decimal strings of usd6. `spentUsd6` = signed (allow) lines that are not cached inside the window; `budgetUsd6` = the smaller of the agent's budget and the global budget (0 for an agent without a policy entry); `remainingUsd6` = budget − spent, floored at 0. The log is the source, so it covers only what the log holds, not the store's pruned view.

Added 2026-11-20 (the agent's own ceiling): `POST /fetch` body may carry `max_usd`, a decimal string with at most 6 decimals or a non-negative number; anything else is 400 `bad max_usd`; `null` or absent means no ceiling. On a 402 whose chosen requirement is worth more than `max_usd`, the request is refused with `ABOVE_MAX` (`asks $X, the agent agreed to at most $Y`), logged with `usd6`, and nothing is read, checked or signed. Equal is allowed. The cache is consulted first, so a cached answer is unaffected.
