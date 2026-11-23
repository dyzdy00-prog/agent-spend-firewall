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
  | { type: "changed"; agent: string; task: string; detail?: string };

export interface NotifyStatus {
  kind: NotifyTarget["kind"];
  /** Where messages go, without the secret part: a host name or a chat id. */
  where: string;
  sent: number;
  failed: number;
  /** Short machine reason of the last failure ("http_404", "timeout", "network"), or null. */
  last_error: string | null;
  /** Local hours during which events are held, or null. */
  quiet: QuietHours | null;
  /** Events held since the quiet hours began. */
  held: number;
}
/** Whole local hours, 0 to 23: quiet from `from` up to, not including, `to`. It may run past midnight. */
export interface QuietHours { from: number; to: number }

/** Pure: whether `hour` falls in the quiet hours. */
export function inQuiet(hour: number, q: QuietHours | null): boolean {
  if (q === null || q.from === q.to) return false;
  return q.from < q.to ? hour >= q.from && hour < q.to : hour >= q.from || hour < q.to;
}
/** Pure: quiet hours from outside, or an error text. null switches them off. */
export function parseQuiet(v: unknown): QuietHours | null | { error: string } {
  if (v === null) return null;
  const q = v as { from?: unknown; to?: unknown } | undefined;
  const hour = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x) && x >= 0 && x <= 23;
  if (typeof q !== "object" || !hour(q.from) || !hour(q.to) || q.from === q.to || Object.keys(q).length !== 2) return { error: "quiet: null, or two different whole hours {from, to} between 0 and 23" };
  return { from: q.from, to: q.to };
}
/** Pure: the one message sent when the quiet hours end. */
export function heldText(counts: Record<string, number>): string {
  const names: Record<string, [string, string]> = { approval: ["payment waited for you", "payments waited for you"], refused: ["payment stopped", "payments stopped"],
    undelivered: ["payment not delivered", "payments not delivered"], budget: ["budget warning", "budget warnings"], autopause: ["agent paused", "agents paused"], changed: ["watch changed", "watches changed"] };
  const parts = Object.keys(names).filter((k) => (counts[k] ?? 0) > 0).map((k) => `${counts[k]} ${names[k]![counts[k] === 1 ? 0 : 1]}`);
  return `While alerts were quiet: ${parts.join(", ")}. Open the console, Rules, to read them.`;
}

/** What happened in a period, for the daily message. Money is already formatted ("0.18"). */
export interface Summary {
  hours: number; requests: number; paid: number; paidUsd: string; stopped: number;
  cached: number; savedUsd: string; undelivered: number;
}

/** One message the firewall tried to send: what it said and whether the channel took it. */
export interface AlertEntry {
  ts: number;
  /** The event type, or "test" / "summary". */
  type: string;
  agent?: string; host?: string; task?: string;
  /** The message as it was sent. */
  text: string;
  ok: boolean;
  /** Short machine reason when it was not delivered ("http_404", "timeout", "network"). */
  error?: string;
  /** 2 when the first attempt failed and the message was sent once more. */
  tries?: number;
}
/** An event that could not be delivered is sent once more after this long. Tests and the owner's own messages do not wait. */
export const RETRY_MS = 30_000;
/** Messages kept in memory and in the log file next to the target file. */
export const ALERT_LOG_MAX = 100;

export interface Notifier {
  /** Sets or clears (null) the quiet hours. Returns the error text, or null when stored. */
  setQuiet(v: unknown): string | null;
  /** Sends the one message about what was held, once the quiet hours are over. Resolves to whether one was sent. */
  flush(): Promise<boolean>;
  /** The latest messages, newest first. */
  log(): AlertEntry[];
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
    if (e.detail !== undefined) return `Watch: ${who}, "${clean(e.task, 80)}": ${clean(e.detail, 120)}. Open the console, Agents, to read it.`;
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
  /** Milliseconds before the one retry of a failed event; default RETRY_MS. */
  retryMs?: number;
  /** The local hour, 0 to 23; default: the machine's clock. */
  hour?: () => number;
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

  // What was sent, kept next to the target file. The text holds no secret: it is what went to the owner's channel.
  const logFile = file.replace(/\.json$/, "") + "-log.jsonl";
  let entries: AlertEntry[] = [];
  try {
    const st = fs.statSync(logFile);
    if ((st.mode & 0o077) === 0) {
      const lines = fs.readFileSync(logFile, "utf8").split("\n").filter((l) => l.trim() !== "");
      for (const l of lines.slice(-ALERT_LOG_MAX)) {
        try {
          const j = JSON.parse(l) as Partial<AlertEntry>;
          if (typeof j.ts !== "number" || typeof j.type !== "string" || typeof j.text !== "string" || typeof j.ok !== "boolean") continue;
          const s = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : undefined);
          const agent = s(j.agent, 80), host = s(j.host, 120), task = s(j.task, 400), error = s(j.error, 40);
          entries.push({ ts: j.ts, type: j.type.slice(0, 20), text: j.text.slice(0, 500), ok: j.ok, ...(j.tries === 2 ? { tries: 2 } : {}),
            ...(agent === undefined ? {} : { agent }), ...(host === undefined ? {} : { host }), ...(task === undefined ? {} : { task }), ...(error === undefined ? {} : { error }) });
        } catch { /* a broken line is skipped */ }
      }
      if (lines.length > ALERT_LOG_MAX * 3) fs.writeFileSync(logFile, entries.map((x) => JSON.stringify(x)).join("\n") + "\n", { mode: 0o600 });
    }
  } catch { /* no log yet */ }
  function note(type: string, e: NotifyEvent | null, text: string, err: string | null, tries: number = 1): void {
    const host = e !== null && "host" in e ? e.host : undefined, task = e !== null && e.type === "changed" ? e.task : undefined;
    const x: AlertEntry = { ts: now(), type, text: text.slice(0, 500), ok: err === null, ...(tries === 2 ? { tries: 2 } : {}),
      ...(e === null ? {} : { agent: e.agent }), ...(host === undefined ? {} : { host }), ...(task === undefined ? {} : { task }), ...(err === null ? {} : { error: err }) };
    entries.push(x);
    if (entries.length > ALERT_LOG_MAX) entries = entries.slice(-ALERT_LOG_MAX);
    try { fs.appendFileSync(logFile, JSON.stringify(x) + "\n", { mode: 0o600 }); } catch { /* the log is a convenience */ }
  }

  // Quiet hours: events are held, written to the log as held, and told in one message when the hours end.
  const hour = opts.hour ?? (() => new Date().getHours());
  const quietFile = file.replace(/\.json$/, "") + "-quiet.json";
  let quiet: QuietHours | null = null;
  let held: Record<string, number> = {};
  try {
    const q = parseQuiet(JSON.parse(fs.readFileSync(quietFile, "utf8")));
    if (q !== null && !("error" in q)) quiet = q;
  } catch { /* no quiet hours */ }
  const heldN = () => Object.values(held).reduce((a, b) => a + b, 0);

  // A channel that is down for a moment should not cost the owner the message: one more attempt, a little later.
  const retryMs = opts.retryMs ?? RETRY_MS;
  async function sendEvent(t: NotifyTarget, text: string, e: NotifyEvent): Promise<{ err: string | null; tries: number }> {
    const first = await post(t, text, e);
    if (first === null) return { err: null, tries: 1 };
    await new Promise<void>((r) => { const timer = setTimeout(r, retryMs); timer.unref?.(); });
    // The owner changed or switched off the channel while it waited: the message is not sent anywhere else.
    if (target !== t) return { err: first, tries: 1 };
    return { err: await post(t, text, e), tries: 2 };
  }

  return {
    setQuiet(v) {
      const q = parseQuiet(v);
      if (q !== null && "error" in q) return q.error;
      try {
        if (q === null) fs.rmSync(quietFile, { force: true });
        else fs.writeFileSync(quietFile, JSON.stringify(q) + "\n", { mode: 0o600 });
      } catch { return "cannot write the quiet hours file; nothing changed"; }
      quiet = q;
      return null;
    },
    async flush() {
      const t = target;
      if (t === null) { held = {}; return false; }
      if (heldN() === 0 || inQuiet(hour(), quiet)) return false;
      const text = heldText(held);
      held = {};
      const err = await post(t, text, null);
      record(err); note("held", null, text, err);
      return err === null;
    },
    log: () => entries.slice().reverse(),
    status: () => (target === null ? null : { kind: target.kind, where: whereOf(target), sent, failed, last_error: lastError, quiet, held: heldN() }),
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
        if (inQuiet(hour(), quiet)) {
          held[e.type] = (held[e.type] ?? 0) + 1;
          note(e.type, e, textOf(e), "held");
          return;
        }
        recent = recent.filter((x) => ts - x < REPEAT_QUIET_S);
        if (recent.length >= MAX_PER_WINDOW || inFlight >= MAX_IN_FLIGHT) return;
        recent.push(ts);
        inFlight++;
        const text = textOf(e);
        void sendEvent(t, text, e).then((r) => { record(r.err); note(e.type, e, text, r.err, r.tries); }, () => { record("network"); note(e.type, e, text, "network"); }).finally(() => { inFlight--; });
      } catch { /* an alert must never break a payment decision */ }
    },
    async test() {
      const t = target;
      if (t === null) return { ok: false, error: "alerts are off" };
      const text = "Test message from your agent spend firewall. Alerts are on.";
      const err = await post(t, text, null);
      record(err); note("test", null, text, err);
      return err === null ? { ok: true } : { ok: false, error: err };
    },
    async summary(s) {
      const t = target;
      if (t === null) return { ok: false, error: "alerts are off" };
      const text = summaryText(s);
      const err = await post(t, text, null);
      record(err); note("summary", null, text, err);
      return err === null ? { ok: true } : { ok: false, error: err };
    },
  };
}
