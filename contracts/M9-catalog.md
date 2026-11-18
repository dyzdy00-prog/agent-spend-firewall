# M9 - Service catalog (MVP)

Implementation: `src/catalog.ts`. Tests: `test/catalog.test.ts` (no network; fixtures in `test/fixtures/catalog-cdp.json`, `catalog-payai.json`, 20 real items each, trimmed).

Purpose: find paid x402 services and compare a live price quote against what public catalogs list. Two public catalogs, no key:
- CDP `https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?limit=N&offset=M` (about 35k resources)
- PayAI `https://facilitator.payai.network/discovery/resources?limit=N&offset=M` (about 17k resources)

Both return `{items, pagination:{limit,offset,total}, x402Version}`. Measured 2026-11-18: both clamp `limit` to 1000 (asking for 5000 returns 1000 items). Items carry `resource` (URL), `description`, `serviceName`, `accepts[]` (`scheme, network, asset, amount, payTo, maxTimeoutSeconds, extra`). PayAI still lists some legacy items with `network: "base" | "solana"` and `maxAmountRequired` instead of `amount`; these are mapped to CAIP-2 (`eip155:8453`, Solana mainnet) and `amount`.

## Exports

```ts
interface CatalogOffer { scheme; network; asset; amountAtoms; payTo; usd? }
interface CatalogEntry { url; host; description; source: "cdp" | "payai"; offers: CatalogOffer[] }

normalize(source, rawItems): CatalogEntry[]
usdOf(offer): string | undefined
refresh(dir, opts?): Promise<{ cdp: number; payai: number }>
load(dir): { entries; fetchedAt } | null
search(entries, query, opts?): CatalogEntry[]
lookup(entries, url): CatalogEntry | null
priceCheck(entry, live, maxRatio): { known, overpriced, ratio?, payeeChanged?, catalogAtoms? }
```

- `normalize` is pure. Skips non-objects, non-http(s) URLs (via `hostOf`, so URLs with credentials are skipped too), items without a valid offer. An offer is valid when scheme, network, asset, payTo are non-empty strings and the amount (`amount` or `maxAmountRequired`) is a non-negative integer (string or safe integer). At most 16 offers per entry (one PayAI item lists 300+). Description: `description`, else `metadata.description`, else `serviceName`; control characters and line breaks replaced by spaces, cut at 300 chars (catalog text is untrusted). Duplicate URLs within one call keep the first.
- `usdOf`: decimal USD string (no floats, trailing zeros trimmed: `5000` -> `"0.005"`) for USDC on Base `0x8335...2913`, Base Sepolia `0x036C...CF7e`, Solana mainnet `EPjF...Dt1v`, Solana devnet `4zMM...ncDU` (6 decimals). EVM asset compare is case-insensitive, Solana exact. Anything else: `undefined`. Note: for `upto` and `batch-settlement` schemes the amount is a maximum, not a fixed price; the scheme is kept on the offer so callers can tell.
- `refresh`: pages with the largest allowed `limit` (1000), 250 ms between pages, 30 s timeout per request, stops at `maxPerSource` (default 100000), at `total`, or on an empty page. Returns the number of entries newly downloaded per source (0 if that source failed). Any error in a source (HTTP error, bad shape, timeout, throw) discards that source's partial download and keeps its previous entries from `dir/catalog.json`. Written atomically: tmp file (mode 0600) in the same directory, then `rename`; directory created with 0700. The file stores only what the catalogs publish (URLs may include the query strings the catalog lists); nothing is logged.
- `load`: `null` when the file is missing, unreadable, not JSON or not version 1. `fetchedAt` is the time of the last refresh run (ms).
- `search`: every whitespace-separated word must occur (case-insensitive) in `url + " " + description`; empty query matches all. `maxUsd` (decimal string) and `network` (CAIP-2) filter offers; entries without any remaining offer are dropped; offers without a known USD value never pass `maxUsd`. Returned entries are copies with offers sorted cheapest first; entries sorted by their cheapest offer, unknown price last, then by URL. `limit` default 10. Input is not mutated.
- `lookup`: exact match on scheme + lowercase host + path, ignoring query string, fragment and trailing slashes. `http` and `https` are different.
- `priceCheck(entry, live, maxRatio)`: `known:false` when `entry` is null or has no offer on the same network + asset (asset case-insensitive for `eip155:*`, exact otherwise). When several offers match, the one with the same payee is used, else the cheapest. `overpriced` = `live > catalog * maxRatio` in bigint math (`maxRatio` is rounded to 3 decimals); a catalog price of 0 makes any positive live price overpriced. `ratio` is `live / catalog` rounded down to 3 decimals, display only, absent when the catalog price is 0. `payeeChanged`: payTo differs (EVM case-insensitive, Solana exact). `catalogAtoms` is the catalog amount used.

## CLI

```
node src/catalog.ts refresh [dir]        # default dir ~/.agent-spend-firewall
node src/catalog.ts search <words...>    # reads $ASF_DIR or ~/.agent-spend-firewall
```

## Limits and notes

- A catalog is a hint, not proof: sellers publish their own entries, and a catalog price can be stale or wrong. `priceCheck` only tells you the live quote differs from the listing; the firewall policy remains the authority.
- Network names are normalized only for the four legacy aliases above; other CAIP-2 ids pass through unchanged.
- Full refresh is about 52 requests and 30 MB of download; the stored file is about 20 MB. Do not run it on a timer faster than daily.
