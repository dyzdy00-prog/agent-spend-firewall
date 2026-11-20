# agent-spend-firewall

A spend firewall for AI agents that pay over [x402](https://github.com/x402-foundation/x402). The signing key and the spending rules live in a separate process the agent cannot reach.

**Status: MVP on testnets (Base Sepolia, Solana devnet). Pre-release, no audit. Do not use with real keys or real money.**

## The problem

The official x402 client caps a single payment at $1 by default. It does not limit what an agent spends over time, how long a signed authorization stays valid, or who gets paid. In our measurements the default client signed 100 authorizations of $0.99 for a page that advertised $0.01 per call, and signed an authorization valid for ten years. Any limit that lives inside the agent can be removed by a compromised agent.

## How it works

```
 agent (token only, no key)
    |  MCP tool fetch_paid_resource(url)   or   POST /fetch
    v
 +-------------------- firewall process (holds the keys) --------------------+
 |  fetch URL -> 402  ->  reader  ->  policy  ->  state  ->  guarded signer  |
 |                        (exact      (caps,      (spend     (signs only what |
 |                         bytes)      rules)      history)   the gate allowed)|
 +----------------------------------------------------------------------------+
    |  signed payment header, retry
    v
 seller / facilitator
```

The agent sends a URL and a bearer token. The firewall fetches it, and on a 402 reads the exact bytes it is about to sign (EIP-712 typed data on EVM, the transaction message on Solana), checks them against the owner's policy and its own spend history, and only then signs. The key never leaves the firewall. Every decision is written to an append-only log (no keys, tokens, URL paths or bodies).

## What is enforced

A payment is refused, and nothing is signed, when:

- it is above the per-payment cap, or below the minimum amount;
- the agent, the host, or everyone together would exceed the budget for the rolling window;
- the payee is not on the allowlist, or differs from the payee first paid on that host (pinning);
- the authorization would stay valid longer than the validity limit;
- the same authorization is presented twice (replay), or too many signatures were made in the window;
- the host already took money without delivering (blocked after N undelivered paid requests);
- the URL resolves to a loopback, private, link-local or other internal address (SSRF guard, checked on the connection itself) or redirects;
- the bytes do not match the payment requirements, carry an unknown instruction, a durable nonce, or are not from the guarded wallet;
- it is not x402 v2 `exact` on Base Sepolia or Solana devnet, or the asset is not on the list.

## Quick start

Needs Node 23.6 or newer.

```
git clone https://github.com/dyzdy00-prog/agent-spend-firewall
cd agent-spend-firewall
npm ci --ignore-scripts
npm start
```

`npm start` is the whole setup. On the first run it creates a private settings folder (`~/.agent-spend-firewall`: config, a testnet wallet, one agent token and one admin token, all mode 0600), starts the firewall on `127.0.0.1:8402` and opens the owner console in your browser, already signed in. The terminal prints the wallet address to fund with free test USDC and the exact `claude mcp add` line for your paths. Later runs reuse the same folder and change nothing in it.

`npm start -- --practice` also starts a local practice seller and, the first time, runs a demo agent against it, so the console shows real decisions straight away: a price above the cap, a seller that swaps its wallet, a seller that takes the payment and returns nothing. While it runs, the console has a Practice panel: buttons that ask as one of your agents (an ordinary purchase, the same one again, a $0.04 dataset that waits for your approval, a runaway loop, a metadata address), so you can try every rule by hand. Practice purchases are signed by your firewall for real and accepted by a practice facilitator on your machine, so no money moves and no test USDC is needed; the console says so in its header. `npm start -- --practice --onchain` settles them on Base Sepolia through the public facilitator instead (the wallet then needs test USDC, and that facilitator fails now and then). `npm start -- --no-open` skips the browser.

Creating an agent: under Agents in the console, pick what the agent does (the ready-made Researcher, or your own agent for any MCP client), give it a name and an hourly budget, and you get its token once.

Researcher (`agents/researcher.ts`): a ready-made buying agent with no key and no model. Given a topic it reads a seller's index of paid notes, buys them one by one through the firewall and returns the notes with a receipt: paid, bought, stopped by the firewall, paid and not delivered, saved by the cache. With `npm start -- --practice` the console runs it at the press of a button against the practice seller (one note is priced over the cap, one seller takes the payment and delivers nothing, so the receipt shows both). By hand: `node agents/researcher.ts "your topic"` with `ASF_AGENT_TOKEN_FILE`, `ASF_RESEARCH_INDEX` and `ASF_RESEARCH_HOSTS`. The practice notes are filler; what the run shows is the buying and the receipt.

Protection between payments (Rules in the console, both off until you turn them on): **first payments to a new seller** are limited to a small amount until that seller delivers once, after which your ordinary limit applies (`policy.new_seller_cap_usd`, refusal `NEW_SELLER`); **same address, higher price** refuses a quote that is more than N times what that address cost the last time it delivered (`max_price_jump`, refusal `PRICE_JUMP`). And always on: a seller that takes the payment and answers with an empty body is counted as not having delivered, like one that answers with an error.

Shopper (`agents/shopper.ts`): the second ready-made agent, also with no key and no model. Given one thing to buy and several sellers' listed prices, it tries the cheapest listing first, moves to the next one when the firewall stops the payment or the seller does not deliver, and stops at the first delivery. The receipt says what it paid, what the dearest listing asked, and what was lost on the way. With `--practice` four practice sellers list the same item: the cheapest asks $5.00 at payment time, the next takes the payment and delivers nothing, the third delivers, the dearest is never asked. By hand: `node agents/shopper.ts "what to buy"` with `ASF_AGENT_TOKEN_FILE`, `ASF_SHOP_QUOTES` and `ASF_SHOP_HOSTS`. Both agents can also run against live testnet sellers, below.

Run history: every finished run of a ready-made agent is kept (`runs.jsonl` next to the state file) and survives a restart. The console lists earlier runs under the Ready-made agents card and on each agent's page; a click opens the run with its steps, receipt and notes.

Schedules: next to Run, "Schedule" repeats the same agent and task every 15 minutes, hour, 6 hours or day. Each scheduled run is an ordinary run as that agent: it spends from the agent's budget, the firewall can stop its payments, and it lands in the run history marked as scheduled. Schedules live in `schedules.json` next to the state file, can be paused or deleted in the console, and only run while the firewall is running.

Live sellers: the Researcher card has a second source, "Live sellers (testnet)", available with or without `--practice`. It looks the topic's words up in the public x402 catalogs (downloaded on the first run, then once a day), picks up to four sellers that accept a testnet under the per-payment cap, one per seller, and buys from each with a plain GET. These are other people's services: some deliver data, some answer an error after taking the payment, some list a testnet and then ask for a mainnet, which the firewall refuses. The wallet needs test USDC (https://faucet.circle.com). Topics the testnet catalog covers today include crypto news, weather, exchange rates and Bitcoin or Ethereum protocol changes; for anything else the run ends with "no testnet seller in the catalog mentions these words".

Reader (optional, `agents/reader.ts`): with an Anthropic API key, each run ends with a short brief of what the bought notes say. Save the key in the console (Agents, Researcher, Reader) or set `ANTHROPIC_API_KEY`; the console stores it in `anthropic.key` next to the state file, mode 0600, and never shows it again. It is one Messages API request per run on `claude-opus-5-5`, with no tools: the notes are third-party text, the prompt marks them as data, and the model can do nothing with them except write the brief. Each note is cut to 4000 characters. Without a key the run still shows the receipt and the notes.

Getting started: on a new install the Overview shows three steps (connect your agent, check the limits, turn on alerts); each is ticked by itself and the card goes away when all three are done or you hide it.

Budget warning: with alerts on, the payment that takes an agent to 80% of its budget in the current window sends one message, so you can raise the budget before the agent is stopped rather than after.

Daily summary: with alerts on, the firewall also sends one line a day at 08:00 local time with the last 24 hours (payments, stopped, saved by cache), on days with activity; the Alerts card has a button that sends it at once.

Alerts: under Rules in the console you can point the firewall at a Discord webhook, a Telegram bot or any https webhook. It then sends a short message when a payment waits for your approval, when an agent is stopped, or when a seller takes a payment and delivers nothing. Approving still happens in the console on the machine the firewall runs on.

Report: the Report tab puts the last 24 hours, 7 days or 30 days on one page (what was paid, what was stopped and why, what the cache saved, by agent and by seller) and prints or saves as a PDF.

### The scripted demo

`npm run demo` runs the same scenarios in a throwaway folder and prints a summary. The first run creates a testnet key and prints the payer address. Fund it with free test USDC (Base Sepolia) at https://faucet.circle.com, then run `npm run demo` again. The demo starts a local seller and the firewall, runs a demo agent through nine scenarios plus a budget burst, and prints a summary with explorer links. It spends at most $0.10 of test USDC. `npm run demo -- --keep` leaves the seller and firewall running; the dashboard is at http://127.0.0.1:8402/. Manual setup and Solana: `bench/README.md`.

## Results

Live run on Base Sepolia, 2026-11-18 (details and transaction links: [bench/RESULTS-2026-11-18.md](bench/RESULTS-2026-11-18.md)):

| Scenario | Outcome |
|---|---|
| `/good` ($0.01) | allowed, delivered, settled on chain |
| `/pricey` ($5.00) | REFUSED CAP, nothing signed |
| payee switch on the same host | REFUSED PAYEE |
| seller takes payment, returns 500 | two allowed, third REFUSED UNDELIVERED |
| burst on `/good` | allowed until the $0.10 budget, then REFUSED BUDGET |

A real Claude agent (Claude Code, Sonnet) was given only the `fetch_paid_resource` MCP tool and bench sources including the $5 report and a failing seller. Every refusal held, six payments settled, and the agent did not try to get around any refusal.

![Dashboard](docs/dashboard.png)

## Use it from an AI agent (MCP)

The agent gets three MCP tools and only a bearer token, never a key. Every payment is decided by the firewall.

**Find, pay, account.** `find_paid_resources(query, max_usd?)` searches the public x402 catalogs (CDP and PayAI) and marks which results the current policy could pay; `fetch_paid_resource(url)` pays (or refuses) and returns the content; `spend_report()` shows budget, spend and refusals. The owner refreshes the catalog with `node src/catalog.ts refresh` (about 30 MB, not more than daily; the firewall never refreshes it itself). With `"max_price_vs_catalog": 3` in the config, a quote more than 3x the listed price is refused as `OVERPRICED` before anything is signed. Catalog text is written by sellers and is treated as untrusted data.

```json
{
  "mcpServers": {
    "spend-firewall": {
      "command": "node",
      "args": ["/path/to/agent-spend-firewall/src/mcp.ts"],
      "env": {
        "ASF_FIREWALL_URL": "http://127.0.0.1:8402",
        "ASF_AGENT_TOKEN_FILE": "/home/you/.agent-spend-firewall/agent.token"
      }
    }
  }
}
```

Claude Code: `claude mcp add spend-firewall -e ASF_AGENT_TOKEN_FILE=$HOME/.agent-spend-firewall/agent.token -- node /path/to/agent-spend-firewall/src/mcp.ts`. Spec: `contracts/M7-mcp.md`.

## Limits and open issues

- Solana devnet settles through our own facilitator (`bench/facilitator.ts`); the public test facilitator fails there on RPC limits. The public devnet RPC is rate-limited per IP, so pace calls or use your own endpoint.
- A signed but unsettled authorization still counts against the budget until it expires, because the seller could still submit it.
- Testnet assets only, stablecoins only (USD), `exact` scheme only. No mainnet, no other schemes.
- Pre-release, not audited. Keys are plain files with mode 0600 under `~/.agent-spend-firewall`.
- The firewall protects the payment path; it does not judge whether the content bought is useful.

## How it is built

Built by a set of AI agents with separated roles: builder, tester who never sees the code, attacker, spec warden and critic, with a script gate that recomputes every number. See [ARCHITECTURE.md](ARCHITECTURE.md). Module specs are frozen in `contracts/` (M1 policy, M2/M3 readers, M4 state, M5 keys, M6 firewall, M7 MCP). Choices and their reasons: [DECISIONS.md](DECISIONS.md). CI runs typecheck and tests on every push and pull request; a pre-commit hook (`scripts/secret-scan.mjs`) refuses keys and secrets. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache-2.0.
