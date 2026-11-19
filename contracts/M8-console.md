# M8 — Owner console: admin API, approvals, web app (FROZEN)

The owner must be able to run the product without editing JSON: set rules, issue and revoke agent tokens, approve large payments, read activity. Files: `src/firewall.ts` (admin API, approvals), `src/console.html` (web app, served at `GET /app`), tests in `test/console.test.ts`.

## Config additions (top level)
- `adminTokenSha256` — sha256 hex of the owner's admin token. Absent → every `/admin/*` route answers 404 (console disabled).
- `approve_above_usd` — decimal string, optional. A payment whose usd value is **above** this (and that passed every policy rule) waits for the owner. Absent → no approvals.
- `approval_timeout_s` — integer 10–3600, default 120.
The firewall remembers the path of the config file it was started with (`startFirewall(cfg, { configPath })`); without it, changes are applied in memory only and `GET /admin/state` reports `"persisted": false`.

## Admin API (loopback only, `Authorization: Bearer <admin token>`, constant-time compare; 401 otherwise)
All bodies JSON, ≤ 16 KB. Money in requests and responses is a decimal USD string (e.g. `"0.05"`).

`GET /admin/state` →
```json
{ "persisted": true, "addresses": { "evm": "0x…", "svm": "…" }, "networks": ["eip155:84532"],
  "rules": { "cap_usd": "0.05", "budget_usd": "0.10", "window_s": 3600, "approve_above_usd": null,
             "block_after_undelivered": 2, "known_hosts_only": false, "max_price_vs_catalog": 3, "cache_ttl_s": 300 },
  "agents": [ { "id": "research", "budget_usd": "0.10", "cap_usd": null, "revoked": false } ],
  "pending": 0 }
```
`PUT /admin/rules` — body: any subset of the `rules` keys above. Validation: decimal strings `^[0-9]+(\.[0-9]{1,6})?$`; `cap_usd > 0`; `budget_usd ≥ cap_usd`; `approve_above_usd` null or `< cap_usd`; `window_s` 60–2592000; `block_after_undelivered` 0–100; `max_price_vs_catalog` null or ≥ 1; `cache_ttl_s` 0–2592000; then `checkPolicy`. Any failure → 400 `{ "error": "<which field and why>" }`, nothing changed. Success → applied atomically to the running policy (next payment uses it), written to the config file (tmp + rename, mode 0600, other keys untouched), response = new `GET /admin/state`.
`POST /admin/agents` — `{ "id": "<1–40 chars [a-z0-9-]>", "budget_usd": "0.10", "cap_usd": null }` → 201 `{ "id", "token" }`. The token (32 random bytes, hex) is returned **once**; only its sha256 is stored. Duplicate id → 409.
`DELETE /admin/agents/<id>` → 200; the agent's token stops working at once (401 on `/fetch`) and the agent is listed with `"revoked": true`. Unknown id → 404.
`POST /admin/practice` — `{ "agent": "<id>", "scenario": "<name>" }` → 200 `{ "status", "paid", "refused", "cached" }` (the `/fetch` result without the body). Exists only when the process was started with practice scenarios (`npm start -- --practice`); otherwise 404. The scenario names are listed in `practice` of `GET /admin/state` (empty array when off); `practice_settlement` there is `"simulated"` (local practice facilitator, nothing goes to a chain), `"testnet"` or `null` when off. The request carries a name, never a URL; unknown name, unknown agent or revoked agent → 400. The fetch goes through the same policy, approval and log path as an agent's own request.
`PUT /admin/alerts` — owner alerts (`src/notify.ts`). Body is one of `{ "kind": "discord", "url": "https://discord.com/api/webhooks/<id>/<token>" }`, `{ "kind": "telegram", "token": "<bot token>", "chat": "<numeric id or @channel>" }`, `{ "kind": "webhook", "url": "https://..." }` (http is accepted for a loopback host only; no user name or password in the URL; at most 500 characters). Anything else → 400. The target is stored in `notify.json` (0600) next to the state file, never in the config file, and is never returned: `alerts` in `GET /admin/state` is `null` when off, else `{ "kind", "where", "sent", "failed", "last_error" }` where `where` is a host name or `chat <id>`. `DELETE /admin/alerts` turns alerts off and removes the file. `POST /admin/alerts/test` sends one test message and answers `{ "ok": true }` or `{ "ok": false, "error": "http_404" | "timeout" | "network" }`; 400 when alerts are off.
Events: a payment starts waiting for approval; a request is refused (not when the owner denied it or the firewall is closing); a payment was signed and nothing was delivered. One plain-text line each; agent ids, host names and reasons are stripped of control characters and markup, Discord gets `allowed_mentions: { parse: [] }`, Telegram gets no parse mode, a plain webhook also gets the event as JSON. The same refusal (agent, host, code) is sent once per 600 s; at most 30 messages per 600 s in total and 5 in flight; redirects are not followed; timeout 5 s. Sending is fire-and-forget: it never delays or changes a payment decision, and a failure is only counted.
`GET /admin/approvals` → `{ "pending": [ { "id", "agent", "host", "network", "usd": "0.40", "payee", "ts", "expiresAt" } ] }` (host only, never the URL path).
`POST /admin/approvals/<id>` — `{ "decision": "approve" | "deny" }` → 200; unknown or already decided → 404.
`GET /admin/activity?limit=N` → `{ "entries": [...] }` newest first, same fields as the decision log, all agents (≤ 500).
`GET /admin/export.csv` → the decision log as CSV with a header row (`ts,agent,host,network,usd,payee,decision,code,reason,delivered,tx`); cells starting with `=`, `+`, `-`, `@` are prefixed with `'` (spreadsheet formula injection).

## Approvals in `/fetch`
After the reader and every policy rule passed and **before signing**: if `approve_above_usd` is set and the payment's usd6 is above it, the request waits. The spend is reserved first (it counts against budgets while pending, so parallel requests cannot overshoot). `approve` → sign and continue as usual. `deny` or timeout → refused `{ code: "APPROVAL", reason: "owner denied" | "no answer in time" }`, the reservation is released (the spend row is removed), nothing was signed. Add `"APPROVAL"` to `RefusalCode`. At most 20 pending approvals; the 21st is refused `APPROVAL` / "too many pending". Log lines: `{…, allow: false, code: "APPROVAL", reason}` for deny/timeout; the normal allow line for approve, with `approved: true`.

## Web app
`GET /app` serves `src/console.html` (single file, no external requests; `Content-Security-Policy: default-src 'self' 'unsafe-inline'; frame-ancestors 'none'`). It is a client of the API above and of `/api/log`. The same file runs as a public demo when the page defines `window.ASF_DEMO` (an in-browser backend with the same shapes).

## Required tests
Admin routes 404 without `adminTokenSha256`, 401 with a wrong token; rules: each validation failure leaves policy and file unchanged, a valid change is applied to the next `/fetch` and survives a reload of the config file; agents: created token works on `/fetch`, is not present anywhere in the config file or state (only the hash), revoke → 401; approvals: approve path signs and pays, deny and timeout sign nothing and release the reservation (budget available again), pending counts against the budget, 21st refused; export escapes formula cells; `/app` served with the CSP header.
