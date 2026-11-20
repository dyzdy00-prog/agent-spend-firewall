# M4 — State (FROZEN, week 1)

Types: `src/types.ts` (`StateView`, `Store`). Implementation file: `src/store.ts`. Uses only the built-in `node:sqlite` (`DatabaseSync`). No network, no key.

## Export

```ts
export function openStore(path: string): Store;   // ":memory:" allowed for tests
export const SCHEMA_VERSION = 1;
```

## Behaviour

- `openStore` creates the schema if the file is new. If the file exists and its schema version ≠ `SCHEMA_VERSION`, or `PRAGMA integrity_check` is not `ok`, it **throws** (fail closed: a broken state must never reset a budget).
- WAL mode, `busy_timeout` ≥ 5000 ms.
- `decideAndRecord` uses `BEGIN IMMEDIATE`, calls `decide(view)` with a view that reads inside the same transaction, and on allow inserts:
  - a spend row `{ts: now, agent, host, chain, network, payee, usd6}`;
  - the replay key with `valid_until = intent.validUntil`;
  - a payee pin for `(host, chain)` only if none exists.
  then `COMMIT`. On refusal or exception: `ROLLBACK`; exceptions are rethrown.
- `usd6` is stored as TEXT (decimal string) and summed as `bigint` in JS — no floating point and no SQLite integer overflow.
- "since" bounds are exclusive (`ts > since`).
- `seenReplayKey(key, now)` is true if the key exists with `valid_until >= now`.
- `prune(now, keepS)` deletes spend rows with `ts <= now - keepS`, undelivered rows with `ts <= now - keepS`, and replay keys with `valid_until < now`. Payee pins are never deleted.
- Never stores signatures, keys, page bodies or full URLs.

## Required tests (minimum)

Budget race: two `Store` instances on the same file and N concurrent callers (worker threads or child processes) each trying to spend; total recorded never exceeds the budget given to `decide`. Exceptions in `decide` leave no rows. Corrupted file and wrong schema version → throw. Bigint sums beyond 2^63. Hosts/agents named `__proto__`. Prune keeps pins.

## Schema version 2 (2026-11-20)

Two tables are added; a version 1 file is upgraded in place when it is opened (inside `BEGIN IMMEDIATE`, existing rows untouched).

- `trusted(host PRIMARY KEY, ts)` — a host that has delivered at least one paid request. `markDelivered(host, now)` inserts once; `deliveredBefore(host)` (part of `StateView`) reads it. Never pruned. The upgrade trusts nobody: a seller paid before the upgrade counts as new until its next delivery.
- `prices(host, path, usd6, ts)`, primary key `(host, path)` — what the last delivered purchase at an address cost. `recordPrice` replaces, `lastPrice` reads, `prune` deletes rows older than 90 days (`PRICE_KEEP_S`).
