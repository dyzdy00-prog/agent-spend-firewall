# M7 — MCP interface (FROZEN, MVP)

File: `src/mcp.ts` (entry point: `node src/mcp.ts`). No dependencies beyond Node: MCP over stdio, newline-delimited JSON-RPC 2.0.

The agent gets one tool and nothing else. The MCP process holds only the agent's bearer token, never a key.

## Configuration (environment)
- `ASF_FIREWALL_URL` — default `http://127.0.0.1:8402`; must be a loopback http URL, else exit 1.
- `ASF_AGENT_TOKEN_FILE` — path to a file containing the bearer token (mode must not allow group/other read, else exit 1). The token never appears in any output.

## Protocol
- `initialize` → `{ protocolVersion: <client's if one of "2025-06-18", "2025-03-26", "2024-11-05", else "2025-06-18">, capabilities: { tools: {} }, serverInfo: { name: "agent-spend-firewall", version } }`.
- `notifications/initialized` and other notifications → no reply.
- `ping` → `{}`.
- `tools/list` → one tool `fetch_paid_resource`: input `{ url: string }` (required), description says payments are decided by the owner's firewall and may be refused.
- `tools/call fetch_paid_resource` → POST `/fetch` to the firewall with the token. Result `content: [{ type: "text", text }]` where text is one status line — `PAID $0.010000 on eip155:84532 (tx 0x…)`, `REFUSED CODE: reason`, or `NO PAYMENT NEEDED` — then the upstream status and body (body cut at 16 000 characters). Refusals are normal results, not errors. `isError: true` only when the firewall is unreachable or answers non-200.
- Unknown method → JSON-RPC error -32601; malformed JSON → -32700; bad params → -32602.
- Logs go to stderr only; stdout carries only JSON-RPC.

## Required tests
Spawn `node src/mcp.ts` with a fake firewall (node:http): initialize/version negotiation, tools/list shape, paid / refused / passthrough text lines, firewall down → isError, token sent as bearer and never echoed, loose token-file permissions → exit 1, non-loopback firewall URL → exit 1, unknown method -32601, malformed line -32700.

## Amendment 2026-11-18 (savings and accounting)

- Second tool `spend_report` (no arguments): calls `GET /report` with the bearer token and returns text: window, budget / spent / remaining, payment counts (delivered, undelivered), refusals by code, saved by cache, up to 5 top sellers. Firewall down or non-200 → `isError`. Both tool descriptions tell the agent it can check its remaining budget before a purchase; `tools/list` now returns two tools.
- `fetch_paid_resource` on a cache hit: first line `CACHED (first paid $0.010000, 42 s ago) — $0 spent`.

## Amendment 2026-11-18 (catalog search)

- Third tool `find_paid_resources` (listed first in `tools/list`): input `{ query: string (required), max_usd?: number >= 0 }`. Calls `GET /search?q=&max_usd=` with the bearer token. Text result: a header (`N of TOTAL matches (catalog 3 h old; ...)` or `No matches ...`), one line per result `$0.0010  base  https://...  [payable] — description` (`[not payable]` when the current policy could not pay it; `$?` when the price is unknown; network names shortened for the four known networks), and a closing reminder that catalog text is third-party and unverified and that prices are re-checked at payment time. Missing or blank `query`, or a bad `max_usd` -> -32602. Firewall answering 503 (no catalog), other non-200, or unreachable -> `isError`.
- `tools/list` now returns three tools. The description says to use it to find a paid API for a task before guessing URLs.
