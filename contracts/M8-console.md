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
             "block_after_undelivered": 2, "known_hosts_only": false, "max_price_vs_catalog": 3, "cache_ttl_s": 300,
             "new_seller_cap_usd": null, "max_price_jump": null },
  "agents": [ { "id": "research", "budget_usd": "0.10", "cap_usd": null, "revoked": false } ],
  "pending": 0 }
```
`PUT /admin/rules` — body: any subset of the `rules` keys above. Validation: decimal strings `^[0-9]+(\.[0-9]{1,6})?$`; `cap_usd > 0`; `budget_usd ≥ cap_usd`; `approve_above_usd` null or `< cap_usd`; `window_s` 60–2592000; `block_after_undelivered` 0–100; `max_price_vs_catalog` null or ≥ 1; `cache_ttl_s` 0–2592000; then `checkPolicy`. Any failure → 400 `{ "error": "<which field and why>" }`, nothing changed. Success → applied atomically to the running policy (next payment uses it), written to the config file (tmp + rename, mode 0600, other keys untouched), response = new `GET /admin/state`.
`POST /admin/agents` — `{ "id": "<1–40 chars [a-z0-9-]>", "budget_usd": "0.10", "cap_usd": null }` → 201 `{ "id", "token" }`. The token (32 random bytes, hex) is returned **once**; only its sha256 is stored. Duplicate id → 409.
`DELETE /admin/agents/<id>` → 200; the agent's token stops working at once (401 on `/fetch`) and the agent is listed with `"revoked": true`. Unknown id → 404.
`POST /admin/practice` — `{ "agent": "<id>", "scenario": "<name>" }` → 200 `{ "status", "paid", "refused", "cached" }` (the `/fetch` result without the body). Exists only when the process was started with practice scenarios (`npm start -- --practice`); otherwise 404. The scenario names are listed in `practice` of `GET /admin/state` (empty array when off); `practice_settlement` there is `"simulated"` (local practice facilitator, nothing goes to a chain), `"testnet"` or `null` when off. The request carries a name, never a URL; unknown name, unknown agent or revoked agent → 400. The fetch goes through the same policy, approval and log path as an agent's own request.
`PUT /admin/alerts` — owner alerts (`src/notify.ts`). Body is one of `{ "kind": "discord", "url": "https://discord.com/api/webhooks/<id>/<token>" }`, `{ "kind": "telegram", "token": "<bot token>", "chat": "<numeric id or @channel>" }`, `{ "kind": "webhook", "url": "https://..." }` (http is accepted for a loopback host only; no user name or password in the URL; at most 500 characters). Anything else → 400. The target is stored in `notify.json` (0600) next to the state file, never in the config file, and is never returned: `alerts` in `GET /admin/state` is `null` when off, else `{ "kind", "where", "sent", "failed", "last_error" }` where `where` is a host name or `chat <id>`. `DELETE /admin/alerts` turns alerts off and removes the file. `POST /admin/alerts/test` sends one test message and answers `{ "ok": true }` or `{ "ok": false, "error": "http_404" | "timeout" | "network" }`; 400 when alerts are off.

`GET /admin/state` also carries `templates`: `[{ id, name, about }]`, the ready-made agents this process can run (empty unless the process was started with them; `npm start -- --practice` provides `researcher`).

`POST /admin/runs` — body `{ "agent": "<id>", "template": "<id>", "task": "<1 to 200 characters>" }`. Runs the template as that agent: every purchase goes through the same path as the agent's own `/fetch` and is counted against its budget. Answers the run at once: `{ id, agent, template, task, started, done, error, steps, result }`; `steps` (`{ kind, title, host, usd, detail }`, at most 50) grow while it works, `result` is set when `done`. 400 for an unknown or revoked agent, an unknown template or a bad task; 409 while that agent already runs a task; 404 when the process has no templates.

`GET /admin/runs` — `{ runs }`, newest first. Query: `agent=<id>` keeps one agent's runs, `limit=<1 to 200>` (default 20; anything else is 400). Each run has `started` and `ended` (null while it works). A finished run is appended as one JSON line to `runs.jsonl` next to the state file (0600) and loaded again at start, up to 200; note texts are cut to 1000 characters there and a line never exceeds 64 KB. A run still working when the process stops is not kept. The decision log remains the record of what was paid; this file is the owner's view of what each run was for.

Schedules run a ready-made agent on a timer as one of the owner's agents. All four routes are 404 without templates.

`GET /admin/schedules` — `{ schedules }`, each `{ id, agent, template, task, every_s, enabled, created, next, last, lastAt }`. `next` is the Unix time of the next run; `last` is `"ran"`, `"skipped: <why>"` or null.

`POST /admin/schedules` — body `{ agent, template, task, every_s }`, `every_s` an integer from 300 to 604800. Same checks as a run (unknown or revoked agent, unknown template, bad task: 400). At most 20. The first run is one interval away. Returns the schedule.

`PUT /admin/schedules/<id>` — body `{ "enabled": true | false }`. Resuming counts the interval from now. `DELETE /admin/schedules/<id>` — returns `{ schedules }`. 404 for an unknown id.

Schedules are kept in `schedules.json` next to the state file (0600). The server checks every 30 seconds; a schedule that is due starts a run with `schedule: <id>` on it. If the agent is revoked, missing or already running a task, that time is skipped, `last` says why, and it is tried again one interval later. A process that was stopped past a schedule's time runs it once after start, not once per missed interval.

`npm start` provides the templates `researcher-live` and `shopper-live` (testnet sellers in the public catalog) and, with `--practice`, `researcher` and `shopper` (practice sellers). The console reads the agent and the source from the id: `<agent>` or `<agent>-live`. A Shopper run's `result` has `kind: "shopper"` and a receipt `{ offered, tried, bought, cached, stopped, undelivered, failed, skipped, paidUsd, priceUsd, dearestUsd, savedUsd, lostUsd }`; its steps add the kind `skipped`. A finished Researcher run's `result` is `{ task, notes, receipt, error?, reading }`; `reading` is `null` when nothing was bought, `{ off: true }` when no model key is set, `{ text, model, inputTokens, outputTokens }` when the Reader wrote a brief, or `{ error }`.

`GET /admin/state` also carries `reader`: `{ configured, source }` with `source` `"file"`, `"env"` or `null`. The key itself is never returned.

`PUT /admin/reader` — body `{ "key": "<20 to 300 characters, no spaces>" }`. Stores the Reader's model key in `anthropic.key` next to the state file (0600). 400 on a malformed key, 500 if the file cannot be written. Returns the state.

`DELETE /admin/reader` — removes that file. A key in `ANTHROPIC_API_KEY` is not affected.

Budget warning: with alerts on, the payment that moves an agent's spending in the current window from below 80% of its budget to 80% or more sends one `budget` message (`{ type, agent, spentUsd, budgetUsd, pct }` in a plain webhook's `event`). No endpoint and no setting.

`POST /admin/alerts/summary` — sends the 24-hour summary now (`{ ok }` or `{ ok: false, error }`; 400 when alerts are off). The same message goes out by itself once a local day at 08:00 when alerts are on and the period had at least one request; a process started after 08:00 skips that day.
Events: a payment starts waiting for approval; a request is refused (not when the owner denied it or the firewall is closing); a payment was signed and nothing was delivered. One plain-text line each; agent ids, host names and reasons are stripped of control characters and markup, Discord gets `allowed_mentions: { parse: [] }`, Telegram gets no parse mode, a plain webhook also gets the event as JSON. The same refusal (agent, host, code) is sent once per 600 s; at most 30 messages per 600 s in total and 5 in flight; redirects are not followed; timeout 5 s. Sending is fire-and-forget: it never delays or changes a payment decision, and a failure is only counted.
`GET /admin/approvals` → `{ "pending": [ { "id", "agent", "host", "network", "usd": "0.40", "payee", "ts", "expiresAt" } ] }` (host only, never the URL path).
`POST /admin/approvals/<id>` — `{ "decision": "approve" | "deny" }` → 200; unknown or already decided → 404.
`GET /admin/activity?limit=N` → `{ "entries": [...] }` newest first, same fields as the decision log, all agents (≤ 500). With `since=<unix seconds>` it returns every entry newer than that instead (newest first, at most 20 000, `limit` ignored) plus `"truncated": true|false`; the console's Report tab uses it.
`GET /admin/export.csv` → the decision log as CSV with a header row (`ts,agent,host,network,usd,payee,decision,code,reason,delivered,tx`); cells starting with `=`, `+`, `-`, `@` are prefixed with `'` (spreadsheet formula injection).

## Approvals in `/fetch`
After the reader and every policy rule passed and **before signing**: if `approve_above_usd` is set and the payment's usd6 is above it, the request waits. The spend is reserved first (it counts against budgets while pending, so parallel requests cannot overshoot). `approve` → sign and continue as usual. `deny` or timeout → refused `{ code: "APPROVAL", reason: "owner denied" | "no answer in time" }`, the reservation is released (the spend row is removed), nothing was signed. Add `"APPROVAL"` to `RefusalCode`. At most 20 pending approvals; the 21st is refused `APPROVAL` / "too many pending". Log lines: `{…, allow: false, code: "APPROVAL", reason}` for deny/timeout; the normal allow line for approve, with `approved: true`.

## Web app
`GET /app` serves `src/console.html` (single file, no external requests; `Content-Security-Policy: default-src 'self' 'unsafe-inline'; frame-ancestors 'none'`). It is a client of the API above and of `/api/log`. The same file runs as a public demo when the page defines `window.ASF_DEMO` (an in-browser backend with the same shapes).

## Required tests
Admin routes 404 without `adminTokenSha256`, 401 with a wrong token; rules: each validation failure leaves policy and file unchanged, a valid change is applied to the next `/fetch` and survives a reload of the config file; agents: created token works on `/fetch`, is not present anywhere in the config file or state (only the hash), revoke → 401; approvals: approve path signs and pays, deny and timeout sign nothing and release the reservation (budget available again), pending counts against the budget, 21st refused; export escapes formula cells; `/app` served with the CSP header.

Rules added 2026-11-20: `new_seller_cap_usd` (null or a decimal above 0 and below `cap_usd`; stored under `policy`) and `max_price_jump` (null or a number from 1 to 1000; stored at the top level). `null` removes the key from the file. Lowering `cap_usd` to `new_seller_cap_usd` or below is refused.

Rule added 2026-11-20: `share_cache` (boolean, stored at the top level).

Added 2026-11-20 (daily limits):
- Rule `daily_budget_usd` (null or a decimal above 0; stored under `policy`).
- `GET /admin/state`: top-level `spent_day_usd`; each agent carries `daily_budget_usd` (or null) and `spent_day_usd` (last 24 hours, "0.40").
- `POST /admin/agents` accepts an optional `daily_budget_usd`.
- `PUT /admin/agents/<id>` with `{ "budget_usd"?: "0.50", "daily_budget_usd"?: "2.00" | null }` changes an agent's limits and answers with the state. 400 on an unknown field, an empty body or a bad amount; 404 unknown agent; 409 revoked agent. The token and everything else about the agent stay as they are.

Added 2026-11-20 (stop switch):
- `PUT /admin/pause` with exactly `{ "paused": true }` or `{ "paused": false }` answers with the state plus `refused_waiting` (payments that were waiting for approval and were refused). 400 on any other body. Written to the config file as `paused: true`, removed when resumed.
- `GET /admin/state` carries `paused`.
- While paused: `POST /admin/runs` answers 409, and a schedule that comes due is skipped with `skipped: payments are paused`.
- Console: a "Pause all payments" button in the top bar on every page; while paused, a banner with "Resume payments" on every page.

Added 2026-11-20 (seller limits): rules `host_budget_usd` and `host_daily_budget_usd` (each null or a decimal above 0; stored under `policy`). Rules has "Most to one seller" with an hourly and a daily choice; the seller page names the limits that are set.

Added 2026-11-20 (pause one agent): `PUT /admin/agents/<id>` accepts `paused` (boolean; anything else 400). The answer is the state plus `refused_waiting`: how many of that agent's waiting approvals were refused. While an agent is paused: its 402s are refused with `PAUSED` / `this agent is paused by the owner` before anything is read, checked or signed; a payment approved while the pause started is released and refused; `POST /admin/runs` for it is 409; its schedules are skipped with `skipped: this agent is paused`; `GET /report` `limits.paused` is true and `canPayUsd6` is "0". The cache and free pages are unaffected. Config key `pausedAgents` (array of ids, absent when empty).

Added 2026-11-20 (pause by itself): rule `auto_pause_after` (null or a whole number 2 to 1000; stored at the top level of the config). When an agent's refusals in a row reach it, the agent is paused as by `PUT /admin/agents/<id> {paused:true}` (its waiting approvals refused, `pausedAgents` written), one `autopause` alert is sent, and its state entry has `auto_paused_after: <count>` until it is resumed. Not counted: refusals with code `PAUSED` or `APPROVAL`, and refusals that never reached a 402. A cached answer neither counts nor resets.

Added 2026-11-20 (Watcher): templates `watcher` (with `--practice`) and `watcher-live`. A run's result is `{kind:"watcher", task, notes, receipt:{checked, changed, first, stopped, undelivered, failed, paidUsd}, fingerprint?, error?}`; steps may have kinds `first`, `same`, `changed` after the purchase step. The last fingerprint per agent, template and task is kept in `watch.json` next to the state file (0600, 200 newest). A run with `changed: 1` sends one `changed` alert.

Added 2026-11-20 (Watcher, field and line): a watcher task may end with ` | <field>` or ` | <field> > <number>` / `< <number>` (field: letters, digits, `_ $ . -`, a dotted path into the JSON answer; up to 80 characters). Anything else is all topic. The result then carries `field`, `value` (at most 80 characters) and, with a line, `met`. With a field the fingerprint is of that value; with a line it is of the side of the line, and `changed` is 1 only when the number is past the line and was not at the last run. An answer without the field, or a field that is not a number when a line is given, is an `error` and nothing is remembered. The `changed` alert carries the step text as `detail`.
