# M1 — Intent and policy (FROZEN, week 1)

Types: `src/types.ts`. Implementation file: `src/policy.ts`. No network, no key, no clock: `now` is always passed in.

## Exports

```ts
export function hostOf(url: string): string | null;
export function toAtoms(decimal: string, decimals: number): bigint;
export function usd6Of(intent: PaymentIntent, asset: AssetRule): bigint;
export function findAsset(assets: AssetRule[], network: string, asset: string): AssetRule | null;
export function evaluate(intent: PaymentIntent, policy: Policy, view: StateView, now: number): Decision;
```

### hostOf
- Returns lowercase `host[:port]` for `http:` and `https:` URLs; `null` for any other scheme, unparseable input, or a URL with username or password.
- One trailing dot on the host name is removed (`api.example.com.:8443` → `api.example.com:8443`).
- Default ports are dropped as WHATWG `URL` drops them.

### toAtoms
- `"0.10", 6` → `100000n`. Accepts only `^[0-9]+(\.[0-9]+)?$`. Throws on more fraction digits than `decimals` or any other format. No floating point anywhere.

### usd6Of
- USD value in millionths, **rounded up**: `ceil(amount * toAtoms(usd_per_unit, 6) / 10^decimals)`.

### findAsset
- Match on exact `network` and on `asset` compared case-insensitively for EVM networks (`eip155:*`) and exactly for all others.

## evaluate — order and codes

Checks run in this order; the first failure is returned. Every refusal has a human-readable `reason` that **must not contain** policy amounts other than the one that was exceeded.

| # | Code | Refuse when |
|---|---|---|
| 1 | `AGENT` | `intent.agent` is not a key of `policy.agents` (use `Object.hasOwn`) |
| 2 | `NETWORK` | `intent.network` not in `policy.networks` |
| 3 | `ASSET` | `findAsset` returns null |
| 4 | `AMOUNT` | `amount <= 0n`, or `amount < toAtoms(min_amount_usd → in asset atoms)`; min is converted with the asset's `usd_per_unit` and rounded **up** |
| 5 | `CAP` | `usd6 > min(cap_usd, agent.cap_usd if set)` (both in usd6) |
| 6 | `VALIDITY` | `validUntil <= now`, or `validUntil - now > max_validity_s` |
| 7 | `REPLAY` | `view.seenReplayKey(replayKey, now)` |
| 8 | `HOST` | agent has `hosts` and `intent.host` is not in it |
| 9 | `UNDELIVERED` | `block_after_undelivered > 0` and `view.undeliveredCount(host, now - undelivered_window_s) >= block_after_undelivered` |
| 10 | `PAYEE` | a list exists at `payees[host][chain]` and `payee` is not in it (EVM compared lowercase, Solana exact); else if `known_hosts_only`; else if `view.pinnedPayee(host, chain)` exists and differs |
| 10b | `NEW_SELLER` | `new_seller_cap_usd` set, `usd6 > new_seller_cap_usd` and `view.deliveredBefore(host)` is false. A host earns the ordinary cap by delivering one paid request; the view is asked only when the amount is over the limit |
| 11 | `COUNT` | `view.count(now - window_s) >= max_signatures_per_window` |
| 12 | `BUDGET` | `view.spentUsd6(now - window_s) + usd6 > budget_usd` |
| 13 | `AGENT_BUDGET` | `view.spentUsd6(now - window_s, {agent}) + usd6 > agent.budget_usd` |
| 14 | `HOST_BUDGET` | `host_budget_usd` set and `view.spentUsd6(now - window_s, {host}) + usd6 > host_budget_usd` |
| 15 | `DAILY_BUDGET` | `daily_budget_usd` set and `view.spentUsd6(now - 86400) + usd6 > daily_budget_usd` (reason `daily limit reached`), or the agent's `daily_budget_usd` set and `view.spentUsd6(now - 86400, {agent}) + usd6 > agents[agent].daily_budget_usd` (reason `agent daily limit reached`). Both absent: the last 24 hours are not read. |

Allow: `{ allow: true, usd6 }`.

All comparisons on amounts use `bigint`. Policy lookups use `Object.hasOwn` so that hosts or agents named `__proto__` or `constructor` behave like any other string.

## Required test vectors (minimum)

The tester writes these from this document, without seeing the implementation:
- every code above, at the boundary (exactly at the limit = allowed, one atom over = refused);
- order: an intent that breaks two rules returns the earlier code;
- 18-decimal asset: repeated payments never exceed the budget due to rounding;
- agent cap lower than global cap, and higher (global wins);
- `__proto__`, `constructor`, `toString` as host and as agent id;
- payee comparison: EVM case-insensitive, Solana case-sensitive;
- `hostOf` on: trailing dot, port, userinfo, `javascript:`, `file:`, uppercase scheme, IPv6 literal.

## Amendment 2026-11-18 (#17)

New exports: `checkPolicy(policy): void` — throws when `window_s` or `max_validity_s` is not a positive integer, when `undelivered_window_s` is not positive while `block_after_undelivered > 0`, or when a `solana:` network is enabled and `max_validity_s < 120`. `minPruneKeepS(policy): number` — `max(window_s, undelivered_window_s if non-delivery blocking is on)`; callers never call `Store.prune` with a smaller `keepS`.

Added 2026-11-20: `DAY_S = 86400` is exported. `checkPolicy` refuses a daily limit (policy or agent) that is not a decimal amount above 0. `minPruneKeepS` is never below `DAY_S`, so a daily limit counts the full 24 hours from the moment it is set.
