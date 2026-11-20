// Owner alerts: a short message to a channel the owner chose when a payment waits, an agent is stopped,
// or a seller takes a payment and does not deliver.
// The target (a webhook address or a bot token) is a secret: it lives in its own 0600 file, is never written to
// config.json, never logged and never returned by the admin API. Sending never delays a payment decision.
import { randomBytes } from "node:crypto";
import fs from "node:fs";

export type NotifyTarget =
  | { kind: "discord"; url: string }
  | { kind: "telegram"; token: string; chat: string }
  | { kind: "webhook"; url: string };

export type NotifyEvent =
  | { type: "approval"; agent: string; host: string; usd: string; waitS: number }
  | { type: "refused"; agent: string; host: string; code: string; reason: string; usd?: string }
  | { type: "undelivered"; agent: string; host: string; usd: string }
  | { type: "budget"; agent: string; spentUsd: string; budgetUsd: string; pct: number; daily?: boolean }
  | { type: "autopause"; agent: string; count: number }
  | { type: "changed"; agent: string; task: string };

export interface NotifyStatus {
  kind: NotifyTarget["kind"];
  /** Where messages go, without the secret part: a host name or a chat id. */
  where: string;
  sent: number;
  failed: number;
  /** Short machine reason of the last failure ("http_404", "timeout", "network"), or null. */
  last_error: string | null;
}

/** What happened in a period, for the daily message. Money is already formatted ("0.18"). */
export interface Summary {
  hours: number; requests: number; paid: number; paidUsd: string; stopped: number;
  cached: number; savedUsd: string; undelivered: number;
}

export interface Notifier {
  status(): NotifyStatus | null;
  /** Validates and stores the target. Returns the error text, or null when stored. */
  set(v: unknown): string | null;
  clear(): void;
  /** Fire and forget. Throttled; never throws. */
  event(e: NotifyEvent): void;
  /** Sends one test message and waits for the answer. */
  test(): Promise<{ ok: boolean; error?: string }>;
  /** Sends the period summary and waits for the answer. */
  summary(s: Summary): Promise<{ ok: boolean; error?: string }>;
}

const DISCORD_HOSTS = new Set(["discord.com", "discordapp.com", "canary.discord.com", "ptb.discord.com"]);
const LOOPBACK = /^(127(\.\d{1,3}){3}|localhost|\[::1\])$/;
const SEND_TIMEOUT_MS = 5_000;
/** The same refusal (agent, seller, reason) is reported once in this many seconds. */
export const REPEAT_QUIET_S = 600;
/** At most this many messages in any REPEAT_QUIET_S window, whatever they are about. */
export const MAX_PER_WINDOW = 30;
const MAX_IN_FLIGHT = 5;
/** Local hour at which the daily summary goes out. */
export const DAILY_HOUR = 8;
/** An agent that has spent this share of its budget in the current window is reported once, before it is stopped. */
export const BUDGET_WARN_PCT = 80;

/** Pure: true when a payment of `lastUsd6` moved spending from below the warning share of the budget to at or above it. */
export function crossedWarn(spentUsd6: bigint, lastUsd6: bigint, budgetUsd6: bigint, pct: number = BUDGET_WARN_PCT): boolean {
  if (budgetUsd6 <= 0n || lastUsd6 <= 0n) return false;
  const line = budgetUsd6 * BigInt(pct);
  return spentUsd6 * 100n >= line && (spentUsd6 - lastUsd6) * 100n < line;
}
const MAX_KEYS = 500;

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** Pure: a usable target, or the reason it is not. */
export function parseTarget(v: unknown): NotifyTarget | { error: string } {
  if (!isObj(v)) return { error: "body must be a JSON object" };
  const kind = v["kind"];
  if (kind === "telegram") {
    for (const k of Object.keys(v)) if (!["kind", "token", "chat"].includes(k)) return { error: `${k}: unknown field` };
    const token = v["token"], chat = v["chat"];
    if (typeof token !== "string" || !/^[0-9]{5,12}:[A-Za-z0-9_-]{30,50}$/.test(token)) return { error: "token: not a Telegram bot token" };
    if (typeof chat !== "string" || !/^(-?[0-9]{1,20}|@[A-Za-z0-9_]{5,32})$/.test(chat)) return { error: "chat: a numeric chat id or @channelname" };
    return { kind, token, chat };
  }
  if (kind !== "discord" && kind !== "webhook") return { error: "kind: must be discord, telegram or webhook" };
  for (const k of Object.keys(v)) if (!["kind", "url"].includes(k)) return { error: `${k}: unknown field` };
  const raw = v["url"];
  if (typeof raw !== "string" || raw.length > 500) return { error: "url: must be a string of at most 500 characters" };
  let u: URL;
  try { u = new URL(raw); } catch { return { error: "url: not a URL" }; }
  if (u.username !== "" || u.password !== "") return { error: "url: must not carry a user name or password" };
  if (kind === "discord") {
    if (u.protocol !== "https:" || !DISCORD_HOSTS.has(u.hostname) || !/^\/api\/webhooks\/[0-9]+\/[A-Za-z0-9_-]+$/.test(u.pathname)) {
      return { error: "url: not a Discord webhook address (https://discord.com/api/webhooks/...)" };
    }
    return { kind, url: `https://${u.hostname}${u.pathname}` };
  }
  // A plain webhook: https anywhere, or http to this machine (a local relay).
  if (u.protocol !== "https:" && !(u.protocol === "http:" && LOOPBACK.test(u.hostname))) return { error: "url: must be https (http is accepted for this machine only)" };
  return { kind, url: u.href };
}

/** Where a target points, without anything that would let someone else post to it. */
export function whereOf(t: NotifyTarget): string {
  if (t.kind === "telegram") return `chat ${t.chat}`;
  try { return new URL(t.url).host; } catch { return ""; }
}

/** Text from outside (agent ids, host names, reasons) is cut down to one short printable line. */
const clean = (s: string, max = 80): string => s.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, " ").replace(/[`*~|<>@\[\]()\\]/g, "").trim().slice(0, max);

/** Pure: the message for an event. Plain text, one line, no markup. */
export function textOf(e: NotifyEvent): string {
  const who = clean(e.agent, 40) || "agent";
  if (e.type === "budget" && e.daily === true) {
    return `Daily limit warning: ${who} has used ${Math.floor(e.pct)}% of its daily limit, $${clean(e.spentUsd, 20)} of $${clean(e.budgetUsd, 20)} in the last 24 hours. At 100% its payments stop. Raise it in the console, Agents.`;
  }
  if (e.type === "budget") {
    return `Budget warning: ${who} has used ${Math.floor(e.pct)}% of its budget, $${clean(e.spentUsd, 20)} of $${clean(e.budgetUsd, 20)} in the current window. At 100% its payments stop. Raise it in the console, Agents.`;
  }
  if (e.type === "autopause") {
    return `Paused: ${who} was refused ${Math.floor(e.count)} times in a row, so the firewall paused it. Nothing is signed for it until you resume it in the console, Agents.`;
  }
  if (e.type === "changed") {
    return `Changed: what ${who} watches, "${clean(e.task, 80)}", is different from the last run. Open the console, Agents, to read it.`;
  }
  const host = clean(e.host, 80) || "seller";
  if (e.type === "approval") return `Approval needed: ${who} wants to pay $${clean(e.usd, 20)} to ${host}. Open the console, Approvals. No answer in ${e.waitS} s means no payment.`;
  if (e.type === "undelivered") return `Paid but not delivered: ${who} paid $${clean(e.usd, 20)} to ${host} and got nothing back.`;
  const amount = e.usd === undefined ? "" : `, $${clean(e.usd, 20)}`;
  return `Stopped: ${who} to ${host}${amount}. ${clean(e.code, 20)}: ${clean(e.reason, 80)}.`;
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** Pure: the daily message. Plain text, one line. */
export function summaryText(s: Summary): string {
  const span = s.hours === 24 ? "Last 24 hours" : `Last ${s.hours} hours`;
  if (s.requests === 0) return `${span}: no requests from your agents.`;
  const parts = [
    `${plural(s.paid, "payment", "payments")}, $${clean(s.paidUsd, 20)}`,
    `${s.stopped} stopped`,
    `${s.cached} served from cache, $${clean(s.savedUsd, 20)} saved`,
  ];
  if (s.undelivered > 0) parts.push(`${s.undelivered} paid and not delivered`);
  return `${span}: ${plural(s.requests, "request", "requests")}. ${parts.join("; ")}. Details: the console, Report.`;
}

/** Pure: local calendar day of `d` ("2026-11-20") when the daily message is due and was not sent for that day, else null. */
export function dueDay(d: Date, lastDay: string, hour: number = DAILY_HOUR): string | null {
  if (d.getHours() < hour) return null;
  const p = (n: number) => String(n).padStart(2, "0");
  const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return day === lastDay ? null : day;
}

/** Pure: the HTTP request that delivers `text` to `t`. */
export function requestFor(t: NotifyTarget, text: string, e: NotifyEvent | null): { url: string; body: string } {
  if (t.kind === "discord") return { url: t.url, body: JSON.stringify({ content: text, allowed_mentions: { parse: [] } }) };
  if (t.kind === "telegram") {
    return { url: `https://api.telegram.org/bot${t.token}/sendMessage`, body: JSON.stringify({ chat_id: t.chat, text, disable_web_page_preview: true }) };
  }
  return { url: t.url, body: JSON.stringify({ text, event: e }) };
}

export interface NotifierOptions {
  fetch?: typeof fetch;
  /** unix seconds */
  now?: () => number;
}

export function createNotifier(file: string, opts: NotifierOptions = {}): Notifier {
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  let target: NotifyTarget | null = null;
  let sent = 0, failed = 0, lastError: string | null = null, inFlight = 0;
  const lastByKey = new Map<string, number>();
  let recent: number[] = [];

  // A file that group or others can read is ignored: the address in it lets anyone post to the owner's channel.
  try {
    const st = fs.statSync(file);
    if ((st.mode & 0o077) === 0) {
      const t = parseTarget(JSON.parse(fs.readFileSync(file, "utf8")));
      if (!("error" in t)) target = t;
    }
  } catch { /* no file: alerts are off */ }

  async function post(t: NotifyTarget, text: string, e: NotifyEvent | null): Promise<string | null> {
    const r = requestFor(t, text, e);
    try {
      const res = await doFetch(r.url, {
        method: "POST", headers: { "content-type": "application/json" }, body: r.body,
        redirect: "error", signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      try { await res.body?.cancel(); } catch { /* nothing to read */ }
      return res.ok ? null : `http_${res.status}`;
    } catch (err) {
      return err instanceof Error && err.name === "TimeoutError" ? "timeout" : "network";
    }
  }
  const record = (err: string | null) => { if (err === null) sent++; else { failed++; lastError = err; } };

  return {
    status: () => (target === null ? null : { kind: target.kind, where: whereOf(target), sent, failed, last_error: lastError }),
    set(v) {
      const t = parseTarget(v);
      if ("error" in t) return t.error;
      const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
      try {
        fs.writeFileSync(tmp, JSON.stringify(t) + "\n", { mode: 0o600, flag: "wx" });
        fs.renameSync(tmp, file);
      } catch {
        try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
        return "cannot write the alerts file; nothing changed";
      }
      target = t; sent = 0; failed = 0; lastError = null; lastByKey.clear(); recent = [];
      return null;
    },
    clear() {
      try { fs.rmSync(file, { force: true }); } catch { /* stays off in memory */ }
      target = null;
    },
    event(e) {
      const t = target;
      if (t === null) return;
      try {
        const ts = now();
        if (e.type !== "approval") {
          const key = [e.type, e.agent, e.type === "budget" ? (e.daily === true ? "day" : "") : e.type === "autopause" ? "" : e.type === "changed" ? e.task : e.host, e.type === "refused" ? e.code : ""].join("\0");
          const last = lastByKey.get(key);
          if (last !== undefined && ts - last < REPEAT_QUIET_S) return;
          lastByKey.delete(key);
          lastByKey.set(key, ts);
          while (lastByKey.size > MAX_KEYS) lastByKey.delete(lastByKey.keys().next().value as string);
        }
        recent = recent.filter((x) => ts - x < REPEAT_QUIET_S);
        if (recent.length >= MAX_PER_WINDOW || inFlight >= MAX_IN_FLIGHT) return;
        recent.push(ts);
        inFlight++;
        void post(t, textOf(e), e).then(record, () => record("network")).finally(() => { inFlight--; });
      } catch { /* an alert must never break a payment decision */ }
    },
    async test() {
      const t = target;
      if (t === null) return { ok: false, error: "alerts are off" };
      const err = await post(t, "Test message from your agent spend firewall. Alerts are on.", null);
      record(err);
      return err === null ? { ok: true } : { ok: false, error: err };
    },
    async summary(s) {
      const t = target;
      if (t === null) return { ok: false, error: "alerts are off" };
      const err = await post(t, summaryText(s), null);
      record(err);
      return err === null ? { ok: true } : { ok: false, error: err };
    },
  };
}
