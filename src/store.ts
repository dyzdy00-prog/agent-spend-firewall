// M4 — State. Implements contracts/M4-state.md using only node:sqlite.
import { DatabaseSync } from "node:sqlite";
import type { Chain, Decision, PaymentIntent, StateView, Store } from "./types.ts";

export const SCHEMA_VERSION = 2;
/** Prices not seen for this long are forgotten. */
export const PRICE_KEEP_S = 90 * 86400;

/** Store plus M8's reservation release. */
export interface FirewallStore extends Store {
  /**
   * Removes the spend row and replay key that `decideAndRecord` wrote for `intent` (same `now`, `usd6`).
   * Used when the owner denies a payment that was reserved while it waited. The host's payee pin is kept (fail closed).
   * Returns true if a spend row was removed.
   */
  releaseSpend(intent: PaymentIntent, now: number, usd6: bigint): boolean;
  /** Records that a paid request to this host was delivered. The first time is kept for good. */
  markDelivered(host: string, now: number): void;
  /** What the last delivered purchase at this host and path cost, in micro-dollars, or null. */
  lastPrice(host: string, path: string): bigint | null;
  recordPrice(host: string, path: string, usd6: bigint, now: number): void;
  /** What one seller was last paid for each address it delivered, the most recent first. */
  pricesOf(host: string, limit: number): { path: string; usd6: bigint; ts: number }[];
}

const SCHEMA = `
CREATE TABLE spend (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  agent TEXT NOT NULL,
  host TEXT NOT NULL,
  chain TEXT NOT NULL,
  network TEXT NOT NULL,
  payee TEXT NOT NULL,
  usd6 TEXT NOT NULL
);
CREATE INDEX spend_ts ON spend(ts);
CREATE TABLE replay (
  key TEXT PRIMARY KEY,
  valid_until INTEGER NOT NULL
);
CREATE TABLE pins (
  host TEXT NOT NULL,
  chain TEXT NOT NULL,
  payee TEXT NOT NULL,
  PRIMARY KEY (host, chain)
);
CREATE TABLE undelivered (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  host TEXT NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX undelivered_host_ts ON undelivered(host, ts);
`;
// Version 2: which sellers have delivered, and what each address last cost.
const SCHEMA_V2 = `
CREATE TABLE IF NOT EXISTS trusted (
  host TEXT PRIMARY KEY,
  ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS prices (
  host TEXT NOT NULL,
  path TEXT NOT NULL,
  usd6 TEXT NOT NULL,
  ts INTEGER NOT NULL,
  PRIMARY KEY (host, path)
);
`;

function userVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number | bigint };
  return Number(row.user_version);
}

function tableCount(db: DatabaseSync): number {
  const row = db.prepare("SELECT count(*) AS n FROM sqlite_master").get() as { n: number | bigint };
  return Number(row.n);
}

export function openStore(path: string): FirewallStore {
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout = 10000");
    const ic = db.prepare("PRAGMA integrity_check").all() as Array<Record<string, unknown>>;
    if (ic.length !== 1 || Object.values(ic[0]!)[0] !== "ok") {
      throw new Error("state: integrity_check failed");
    }
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = FULL");

    if (tableCount(db) === 0 && userVersion(db) === 0) {
      // New file: create under an exclusive write lock; re-check in case another opener won the race.
      db.exec("BEGIN IMMEDIATE");
      try {
        if (tableCount(db) === 0 && userVersion(db) === 0) {
          db.exec(SCHEMA);
          db.exec(SCHEMA_V2);
          db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
        }
        db.exec("COMMIT");
      } catch (e) {
        try { db.exec("ROLLBACK"); } catch { /* ignore */ }
        throw e;
      }
    }
    if (userVersion(db) === 1) {
      // Version 1 file: add the two tables. Nothing existing is touched; no seller counts as having delivered yet.
      db.exec("BEGIN IMMEDIATE");
      try {
        if (userVersion(db) === 1) {
          db.exec(SCHEMA_V2);
          db.exec("PRAGMA user_version = 2");
        }
        db.exec("COMMIT");
      } catch (e) {
        try { db.exec("ROLLBACK"); } catch { /* ignore */ }
        throw e;
      }
    }
    const v = userVersion(db);
    if (v !== SCHEMA_VERSION) {
      throw new Error(`state: schema version ${v}, expected ${SCHEMA_VERSION}`);
    }
  } catch (e) {
    try { db.close(); } catch { /* ignore */ }
    throw e;
  }

  const qSpend = db.prepare("SELECT usd6 FROM spend WHERE ts > ?");
  const qSpendAgent = db.prepare("SELECT usd6 FROM spend WHERE ts > ? AND agent = ?");
  const qSpendHost = db.prepare("SELECT usd6 FROM spend WHERE ts > ? AND host = ?");
  const qSpendBoth = db.prepare("SELECT usd6 FROM spend WHERE ts > ? AND agent = ? AND host = ?");
  const qCount = db.prepare("SELECT count(*) AS n FROM spend WHERE ts > ?");
  const qCountAgent = db.prepare("SELECT count(*) AS n FROM spend WHERE ts > ? AND agent = ?");
  const qPin = db.prepare("SELECT payee FROM pins WHERE host = ? AND chain = ?");
  const qUndelivered = db.prepare("SELECT count(*) AS n FROM undelivered WHERE host = ? AND ts > ?");
  const qReplay = db.prepare("SELECT 1 AS x FROM replay WHERE key = ? AND valid_until >= ?");
  const iSpend = db.prepare(
    "INSERT INTO spend (ts, agent, host, chain, network, payee, usd6) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const iReplay = db.prepare("INSERT OR REPLACE INTO replay (key, valid_until) VALUES (?, ?)");
  const iPin = db.prepare("INSERT OR IGNORE INTO pins (host, chain, payee) VALUES (?, ?, ?)");
  const iUndelivered = db.prepare("INSERT INTO undelivered (host, ts) VALUES (?, ?)");
  const qTrusted = db.prepare("SELECT 1 AS x FROM trusted WHERE host = ?");
  const iTrusted = db.prepare("INSERT OR IGNORE INTO trusted (host, ts) VALUES (?, ?)");
  const qPrice = db.prepare("SELECT usd6 FROM prices WHERE host = ? AND path = ?");
  const qPrices = db.prepare("SELECT path, usd6, ts FROM prices WHERE host = ? ORDER BY ts DESC, path LIMIT ?");
  const iPrice = db.prepare("INSERT OR REPLACE INTO prices (host, path, usd6, ts) VALUES (?, ?, ?, ?)");
  const dPrices = db.prepare("DELETE FROM prices WHERE ts <= ?");
  const dSpend = db.prepare("DELETE FROM spend WHERE ts <= ?");
  const dUndelivered = db.prepare("DELETE FROM undelivered WHERE ts <= ?");
  const dReplay = db.prepare("DELETE FROM replay WHERE valid_until < ?");
  const dReleaseSpend = db.prepare(
    "DELETE FROM spend WHERE id = (SELECT max(id) FROM spend WHERE ts = ? AND agent = ? AND host = ? AND chain = ? AND network = ? AND payee = ? AND usd6 = ?)",
  );
  const dReleaseReplay = db.prepare("DELETE FROM replay WHERE key = ?");

  let closed = false;
  const live = () => {
    if (closed) throw new Error("state: store is closed");
  };

  const sumRows = (rows: Array<Record<string, unknown>>): bigint => {
    let total = 0n;
    for (const r of rows) total += BigInt(r["usd6"] as string);
    return total;
  };

  const view: StateView = {
    spentUsd6(since, filter) {
      live();
      const a = filter?.agent;
      const h = filter?.host;
      let rows: Array<Record<string, unknown>>;
      if (a !== undefined && h !== undefined) rows = qSpendBoth.all(since, a, h);
      else if (a !== undefined) rows = qSpendAgent.all(since, a);
      else if (h !== undefined) rows = qSpendHost.all(since, h);
      else rows = qSpend.all(since);
      return sumRows(rows);
    },
    count(since, filter) {
      live();
      const row = (filter?.agent !== undefined ? qCountAgent.get(since, filter.agent) : qCount.get(since)) as {
        n: number | bigint;
      };
      return Number(row.n);
    },
    pinnedPayee(host: string, chain: Chain) {
      live();
      const row = qPin.get(host, chain) as { payee: string } | undefined;
      return row ? row.payee : null;
    },
    undeliveredCount(host, since) {
      live();
      const row = qUndelivered.get(host, since) as { n: number | bigint };
      return Number(row.n);
    },
    seenReplayKey(key, now) {
      live();
      return qReplay.get(key, now) !== undefined;
    },
    deliveredBefore(host) {
      live();
      return qTrusted.get(host) !== undefined;
    },
  };

  const store: FirewallStore = {
    ...view,
    decideAndRecord(intent: PaymentIntent, now: number, decide: (v: StateView) => Decision): Decision {
      live();
      db.exec("BEGIN IMMEDIATE");
      let decision: Decision;
      try {
        decision = decide(view);
        if (decision.allow) {
          if (typeof decision.usd6 !== "bigint" || decision.usd6 < 0n) {
            throw new Error("state: allow decision needs a non-negative bigint usd6");
          }
          iSpend.run(now, intent.agent, intent.host, intent.chain, intent.network, intent.payee, decision.usd6.toString());
          iReplay.run(intent.replayKey, intent.validUntil);
          iPin.run(intent.host, intent.chain, intent.payee);
          db.exec("COMMIT");
          return decision;
        }
      } catch (e) {
        try { db.exec("ROLLBACK"); } catch { /* ignore */ }
        throw e;
      }
      try { db.exec("ROLLBACK"); } catch { /* ignore */ }
      return decision;
    },
    releaseSpend(intent, now, usd6) {
      live();
      db.exec("BEGIN IMMEDIATE");
      try {
        const r = dReleaseSpend.run(now, intent.agent, intent.host, intent.chain, intent.network, intent.payee, usd6.toString());
        dReleaseReplay.run(intent.replayKey);
        db.exec("COMMIT");
        return Number(r.changes) > 0;
      } catch (e) {
        try { db.exec("ROLLBACK"); } catch { /* ignore */ }
        throw e;
      }
    },
    markUndelivered(host, now) {
      live();
      iUndelivered.run(host, now);
    },
    markDelivered(host, now) {
      live();
      iTrusted.run(host, now);
    },
    lastPrice(host, path) {
      live();
      const row = qPrice.get(host, path) as { usd6: string } | undefined;
      if (row === undefined || !/^[0-9]{1,30}$/.test(row.usd6)) return null;
      return BigInt(row.usd6);
    },
    pricesOf(host, limit) {
      live();
      const rows = qPrices.all(host, Math.max(0, Math.floor(limit))) as { path: string; usd6: string; ts: number }[];
      return rows.filter((r) => /^[0-9]{1,30}$/.test(r.usd6)).map((r) => ({ path: r.path, usd6: BigInt(r.usd6), ts: Number(r.ts) }));
    },
    recordPrice(host, path, usd6, now) {
      live();
      if (usd6 < 0n) throw new Error("state: price must not be negative");
      iPrice.run(host, path, usd6.toString(), now);
    },
    prune(now, keepS) {
      live();
      db.exec("BEGIN IMMEDIATE");
      try {
        dSpend.run(now - keepS);
        dUndelivered.run(now - keepS);
        dPrices.run(now - PRICE_KEEP_S);
        dReplay.run(now);
        db.exec("COMMIT");
      } catch (e) {
        try { db.exec("ROLLBACK"); } catch { /* ignore */ }
        throw e;
      }
    },
    close() {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
  return store;
}
