// M4 — State. Implements contracts/M4-state.md using only node:sqlite.
import { DatabaseSync } from "node:sqlite";
import type { Chain, Decision, PaymentIntent, StateView, Store } from "./types.ts";

export const SCHEMA_VERSION = 1;

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

function userVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number | bigint };
  return Number(row.user_version);
}

function tableCount(db: DatabaseSync): number {
  const row = db.prepare("SELECT count(*) AS n FROM sqlite_master").get() as { n: number | bigint };
  return Number(row.n);
}

export function openStore(path: string): Store {
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
          db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
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
  const dSpend = db.prepare("DELETE FROM spend WHERE ts <= ?");
  const dUndelivered = db.prepare("DELETE FROM undelivered WHERE ts <= ?");
  const dReplay = db.prepare("DELETE FROM replay WHERE valid_until < ?");

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
  };

  const store: Store = {
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
    markUndelivered(host, now) {
      live();
      iUndelivered.run(host, now);
    },
    prune(now, keepS) {
      live();
      db.exec("BEGIN IMMEDIATE");
      try {
        dSpend.run(now - keepS);
        dUndelivered.run(now - keepS);
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
