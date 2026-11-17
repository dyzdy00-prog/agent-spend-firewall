# agent-spend-firewall

A spend firewall for AI agents that pay over [x402](https://github.com/x402-foundation/x402).

**Status: pre-release, week 0. Testnets only. Do not use with real keys or real money.**

## The problem

The official x402 client caps a single payment at $1 by default. It does not limit what an agent spends over time, how long a signed authorization stays valid, or who gets paid. In our measurements the default client signed 100 authorizations of $0.99 for a page that advertised $0.01 per call, and signed an authorization valid for ten years. Any limit that lives inside the agent can be removed by a compromised agent.

## The idea

The key and the rules live in a separate process the agent cannot reach. The agent asks for a resource; the firewall reads the exact bytes it is about to sign, checks them against the owner's policy (per-agent budgets, validity, pinned payees, delivery), and signs only what passes.

## How this is built

Built by a set of AI agents with separated roles (builder, tester who never sees the code, attacker, spec warden, critic) and a script gate that recomputes every number. See [ARCHITECTURE.md](ARCHITECTURE.md).

## Background

The measurements behind this project (catalog census of 44,840 paid URLs, client library test, guard prototype) are summarized in the write-up that preceded it; it will be added under `docs/`.

## License

Apache-2.0.
