# Architecture and working process

Status: week 0. Nothing here is ready for real money.

## 1. How big x402 is

Counted from the official repository `x402-foundation/x402` on 2026-11-17.

| Branch | Count | What |
|---|---|---|
| Schemes | **4** | `exact` (exact amount), `upto` (up to a maximum, final amount known after the work), `auth-capture` (authorize now, capture later), `batch-settlement` (many small payments settled together) |
| Scheme × network specs | **27** | `exact` on 18 networks (EVM, Solana, Aptos, Algorand, Stellar, Sui, TON, NEAR, XRPL, Hedera, Starknet, Cardano, Lightning and others); `upto` on 3; `auth-capture` on 1; `batch-settlement` on 3 plus a Cloudflare variant |
| EVM transfer methods | **2** | EIP-3009 (USDC, one-time signature) and Permit2 (any ERC-20 through a proxy contract) |
| Transports | **3** | HTTP, MCP, A2A |
| Extensions | **9** | Bazaar catalog, Sign-in-with-X, payment identifier, offer and receipt, HTTP message signatures, two gas sponsoring extensions, builder code, auth hints |
| TypeScript mechanism packages | **14** | one per network family |
| TypeScript HTTP packages | **7** | axios, express, fastify, fetch, hono, next, paywall |
| Protocol versions | **2** | v1 (still spoken by 332 of 6,999 live endpoints in our census) and v2 |

The public test facilitator (`x402.org/facilitator`) currently accepts `exact` on Base Sepolia, Solana devnet, Algorand, Aptos, Stellar, Hedera and XRPL testnets, and `upto` and `batch-settlement` on Base Sepolia only.

Every branch is another way to sign money away, and the firewall has to understand each one down to the byte. Depth first, breadth later.

## 2. Scope of the first month

| In | Why |
|---|---|
| `exact` on EVM (EIP-3009) | Most of the live traffic in our census; we already have a prototype |
| `exact` on Solana | Second largest; the payer signs a whole transaction, not a typed message, so it proves the core is really chain-agnostic |
| HTTP and MCP transports | HTTP for pages; MCP because that is how agents (Claude, Cursor and others) actually connect |
| Protocol v1 and v2 | v1 is still alive |

**Everything else is refused by default.** An unknown scheme, network or transfer method is a refusal, never a guess. Next phase: `upto` (the most dangerous for budgets: the maximum is signed, not the real amount), Permit2, `batch-settlement`.

## 3. Modules

Each module gets a **contract** before anyone builds it: inputs, outputs, error codes and a set of test vectors. The contract is frozen once written.

| # | Module | Does | Depends on |
|---|---|---|---|
| M1 | Intent and policy | A chain-agnostic payment intent (network, asset, amount, payee, validity, host, agent) and the rules over it. No network, no key | — |
| M2 | EVM reader | EIP-3009 typed data → intent; everything else refused | M1 contract |
| M3 | Solana reader | Solana transaction bytes → intent; only known instructions allowed | M1 contract |
| M4 | State | Spend, payee and non-delivery records (SQLite; one decision = one transaction) | M1 contract |
| M5 | Key custody | Keys in the OS keychain or under a separate OS user; signs only what M1 allowed | M1–M4 |
| M6 | Firewall process | Fetches the paid page itself; address checks, delivery checks, per-agent access tokens | M1–M5 |
| M7 | MCP interface | One tool for the agent: "fetch this paid resource" | M6 |
| M8 | Approval by phone | Above a threshold the owner gets "allow / deny" | M6 |
| M9 | Catalog check | Payee and price compared with public x402 catalogs | M1 |
| M10 | Dashboard | Spend, refusals, rules; for the human only | M4, M6 |
| M11 | Test bench | Test seller, facilitator, real settlement on Base Sepolia and Solana devnet | M6 |

Week 1 builds M1–M5 and the base of M11. M2, M3 and M4 run in parallel because they only depend on the M1 contract.

## 4. Roles: whoever builds does not check

A single agent that both decides what to build and decides whether it works will defend its own answer to the end. So the work is split between agents that cannot see each other's reasoning.

| Role | Who | Gets | Does not get |
|---|---|---|---|
| **Dispatcher** | the main session | everything | does not grade its own work |
| **Builder** | one agent per module | the contract, the x402 spec, its own folder | write access to other modules |
| **Tester** | a separate agent | the contract and the spec | **the builder's code**: tests are written from what must be true, not from what was written |
| **Attacker** | a separate agent | the finished code and the threat model | the builder's explanations; it wins only by finding a working bypass, delivered as a failing test |
| **Spec warden** | a separate agent | the code and the official x402 spec | any report; checks that we read bytes the way the protocol defines them |
| **Critic** | a separate agent, strongest model | files, logs, the report | the conclusion; returns PASS or a list of errors |
| **Gate** | a script, not an agent | — | — ; runs all tests and type checks and recomputes every number in a report from the logs |
| **Owner** | the human | a summary with evidence | decides direction, real money, releases |

## 5. Pipeline for one module

```
Contract (dispatcher, frozen)
   ├─► Builder ──┐
   └─► Tester  ──┴─► GATE (tests, types) ──► Attacker ──► Spec warden ──► Critic ──► Merge
                       │ fail                  │ found        │ found         │ FAIL
                       └──── back to builder ◄─┴──────────────┴───────────────┘   (max 3 rounds, then the owner decides)
```

Rules:

1. **Whoever builds does not check; whoever checks does not see the builder's explanation.**
2. **The contract is frozen.** A builder who thinks it is wrong files a change request; the dispatcher decides and records it in `DECISIONS.md` (who, why, when).
3. **Disagreements are settled by a running test, not by argument.** If no test can be written, a third agent gets both positions without authorship; if that is still unclear, the owner decides.
4. **At most three rounds per module.** Then we stop and escalate.
5. **Agents do not see each other's conclusions** until they have handed in their own.
6. **Each agent writes only to its own folder or branch.** Two agents never edit the same file.

## 6. Reports and who checks them

Every agent report has the same shape:

| Section | Content |
|---|---|
| Done | list |
| Evidence | for each claim: the command that was run and the file with its output |
| Not tested | explicit, separate |
| Risks | noticed but not fixed |

Checked in three layers:

1. **Gate (script):** reruns every command named in the report and compares the result. A number without a source file rejects the report automatically.
2. **Critic:** does the conclusion follow from the evidence, and is anything left out.
3. **Dispatcher:** passes on to the owner only what survived both; anything unverified is labelled as such.

## 7. Capacity

- Week 1: three builders (M2, M3, M4) in parallel after M1, each with a tester; then two attackers, one spec warden, one critic. About 10–12 agent runs per week, **at most 4 at a time**.
- The pipeline in section 5 runs as a scripted workflow, so steps cannot be skipped.
- Everything is developed in the open in this repository. Keys, state databases and logs with signatures never enter it; a pre-commit check refuses obvious secrets.
