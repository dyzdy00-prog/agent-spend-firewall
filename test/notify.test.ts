// Owner alerts: target validation, message text, throttling, the private file. No network: fetch is replaced.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BUDGET_WARN_PCT, createNotifier, crossedWarn, dueDay, MAX_PER_WINDOW, parseTarget, REPEAT_QUIET_S, requestFor, summaryText, textOf, whereOf } from "../src/notify.ts";
import type { NotifyEvent } from "../src/notify.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "asf-notify-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
let n = 0;
const file = () => path.join(tmp, `notify-${++n}.json`);
// Shaped like the real things, made of filler.
const HOOK = "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyzABCDEF";
const BOT = "1234567890:" + "a".repeat(35);
const refused = (over: Partial<Extract<NotifyEvent, { type: "refused" }>> = {}): NotifyEvent =>
  ({ type: "refused", agent: "agent-1", host: "api.example.com", code: "CAP", reason: "above cap", usd: "5.00", ...over });

interface Sent { url: string; body: any; redirect: unknown }
function fake(answer: (i: number) => Response | Promise<Response> = () => new Response("ok", { status: 200 })) {
  const sent: Sent[] = [];
  const f = (async (url: any, init: any) => {
    sent.push({ url: String(url), body: JSON.parse(init.body), redirect: init.redirect });
    return answer(sent.length);
  }) as typeof fetch;
  return { sent, f };
}
const settle = () => new Promise((r) => setTimeout(r, 20));

describe("owner alerts", () => {
  it("parseTarget accepts the three kinds and nothing else", () => {
    assert.deepEqual(parseTarget({ kind: "discord", url: HOOK + "?wait=true" }), { kind: "discord", url: HOOK });
    assert.deepEqual(parseTarget({ kind: "telegram", token: BOT, chat: "-1001234567890" }), { kind: "telegram", token: BOT, chat: "-1001234567890" });
    assert.deepEqual(parseTarget({ kind: "webhook", url: "https://hooks.example.com/in" }), { kind: "webhook", url: "https://hooks.example.com/in" });
    assert.deepEqual(parseTarget({ kind: "webhook", url: "http://127.0.0.1:9000/x" }), { kind: "webhook", url: "http://127.0.0.1:9000/x" });
    for (const bad of [
      null, [], "x", {}, { kind: "slack", url: HOOK },
      { kind: "discord", url: "https://evil.example/api/webhooks/1/abc" },
      { kind: "discord", url: "http://discord.com/api/webhooks/1/abc" },
      { kind: "discord", url: "https://discord.com/channels/1/2" },
      { kind: "discord", url: "https://discord.com.evil.example/api/webhooks/1/abc" },
      { kind: "discord", url: HOOK, extra: 1 },
      { kind: "webhook", url: "http://hooks.example.com/in" },
      { kind: "webhook", url: "https://user:pass@hooks.example.com/in" },
      { kind: "webhook", url: "file:///etc/passwd" },
      { kind: "webhook", url: "https://x.example/" + "a".repeat(500) },
      { kind: "telegram", token: "nope", chat: "1" },
      { kind: "telegram", token: BOT, chat: "my chat" },
      { kind: "telegram", token: BOT + "/../x", chat: "1" },
    ]) assert.ok("error" in (parseTarget(bad) as object), JSON.stringify(bad));
  });

  it("whereOf never shows the secret part", () => {
    assert.equal(whereOf({ kind: "discord", url: HOOK }), "discord.com");
    assert.equal(whereOf({ kind: "telegram", token: BOT, chat: "42" }), "chat 42");
    assert.equal(whereOf({ kind: "webhook", url: "https://hooks.example.com/in/secret-path" }), "hooks.example.com");
  });

  it("text is one plain line; outside text cannot add mentions, links or new lines", () => {
    const t = textOf(refused({ agent: "a@everyone\n<@123>", host: "x.example", reason: "see [this](http://evil.example) `now`" }));
    assert.equal(/[\n@<>\[\]()`]/.test(t), false, t);
    assert.ok(t.startsWith("Stopped: "));
    assert.ok(textOf({ type: "approval", agent: "a", host: "h.example", usd: "0.40", waitS: 120 }).includes("$0.40"));
    assert.ok(textOf({ type: "undelivered", agent: "a", host: "h.example", usd: "0.01" }).startsWith("Paid but not delivered"));
    assert.ok(textOf(refused({ reason: "x".repeat(500) })).length < 250);
  });

  it("requestFor: Discord forbids mentions, Telegram sends plain text, a webhook also gets the event", () => {
    const d = requestFor({ kind: "discord", url: HOOK }, "hi", null);
    assert.equal(d.url, HOOK);
    assert.deepEqual(JSON.parse(d.body), { content: "hi", allowed_mentions: { parse: [] } });
    const t = requestFor({ kind: "telegram", token: BOT, chat: "42" }, "hi", null);
    assert.equal(t.url, `https://api.telegram.org/bot${BOT}/sendMessage`);
    assert.deepEqual(JSON.parse(t.body), { chat_id: "42", text: "hi", disable_web_page_preview: true });
    const w = requestFor({ kind: "webhook", url: "https://h.example/in" }, "hi", refused());
    assert.equal(JSON.parse(w.body).event.code, "CAP");
  });

  it("off by default; set writes a 0600 file that a new notifier reads; clear removes it", async () => {
    const f = file(), net = fake();
    const a = createNotifier(f, { fetch: net.f });
    assert.equal(a.status(), null);
    a.event(refused());
    await settle();
    assert.equal(net.sent.length, 0);
    assert.deepEqual(await a.test(), { ok: false, error: "alerts are off" });
    assert.equal(typeof a.set({ kind: "discord", url: "https://evil.example/x" }), "string");
    assert.equal(fs.existsSync(f), false);

    assert.equal(a.set({ kind: "discord", url: HOOK }), null);
    assert.equal(fs.statSync(f).mode & 0o777, 0o600);
    assert.deepEqual(a.status(), { kind: "discord", where: "discord.com", sent: 0, failed: 0, last_error: null });
    assert.equal(JSON.stringify(a.status()).includes("abcdefghij"), false);

    const b = createNotifier(f, { fetch: net.f });
    assert.equal(b.status()?.kind, "discord");
    b.clear();
    assert.equal(b.status(), null);
    assert.equal(fs.existsSync(f), false);
  });

  it("a file readable by others is ignored", () => {
    const f = file();
    fs.writeFileSync(f, JSON.stringify({ kind: "discord", url: HOOK }), { mode: 0o644 });
    assert.equal(createNotifier(f).status(), null);
  });

  it("the same refusal is reported once per quiet period; approvals are never merged; a flood is capped", async () => {
    let t = 1_000_000;
    const net = fake();
    const a = createNotifier(file(), { fetch: net.f, now: () => t });
    a.set({ kind: "webhook", url: "https://h.example/in" });
    for (let i = 0; i < 20; i++) a.event(refused());
    await settle();
    assert.equal(net.sent.length, 1);
    assert.equal(net.sent[0]!.redirect, "error");
    a.event(refused({ code: "BUDGET" }));
    a.event(refused({ agent: "agent-2" }));
    await settle();
    assert.equal(net.sent.length, 3);
    for (let i = 0; i < 2; i++) { a.event({ type: "approval", agent: "agent-1", host: "api.example.com", usd: "0.40", waitS: 120 }); await settle(); }
    assert.equal(net.sent.length, 5);

    t += REPEAT_QUIET_S;
    a.event(refused());
    await settle();
    assert.equal(net.sent.length, 6);

    for (let i = 0; i < MAX_PER_WINDOW + 10; i++) { a.event(refused({ agent: `flood-${i}` })); await settle(); }
    assert.equal(net.sent.length, 5 + MAX_PER_WINDOW);
    assert.equal(a.status()?.sent, 5 + MAX_PER_WINDOW);
  });

  it("the daily message: one plain line, due once a local day after the hour", async () => {
    const s = { hours: 24, requests: 12, paid: 9, paidUsd: "0.18", stopped: 3, cached: 2, savedUsd: "0.04", undelivered: 0 };
    assert.equal(summaryText(s), "Last 24 hours: 12 requests. 9 payments, $0.18; 3 stopped; 2 served from cache, $0.04 saved. Details: the console, Report.");
    assert.ok(summaryText({ ...s, paid: 1, undelivered: 6 }).includes("1 payment, $0.18") && summaryText({ ...s, undelivered: 6 }).includes("6 paid and not delivered"));
    assert.equal(summaryText({ ...s, requests: 0 }), "Last 24 hours: no requests from your agents.");
    assert.equal(/[\n@<>\[\]()`]/.test(summaryText({ ...s, paidUsd: "1<@everyone>" })), false);

    assert.equal(dueDay(new Date(2026, 10, 20, 7, 59), ""), null);
    assert.equal(dueDay(new Date(2026, 10, 20, 8, 0), ""), "2026-11-20");
    assert.equal(dueDay(new Date(2026, 10, 20, 23, 0), "2026-11-20"), null);
    assert.equal(dueDay(new Date(2026, 10, 21, 9, 0), "2026-11-20"), "2026-11-21");

    const net = fake();
    const a = createNotifier(file(), { fetch: net.f });
    assert.deepEqual(await a.summary(s), { ok: false, error: "alerts are off" });
    a.set({ kind: "discord", url: HOOK });
    assert.deepEqual(await a.summary(s), { ok: true });
    assert.equal(net.sent[0]!.body.content.startsWith("Last 24 hours: 12 requests."), true);
    assert.equal(a.status()?.sent, 1);
  });

  it("the budget warning: fires on the payment that crosses the line, once; one plain line", async () => {
    assert.equal(BUDGET_WARN_PCT, 80);
    assert.equal(crossedWarn(79n, 1n, 100n), false);
    assert.equal(crossedWarn(80n, 1n, 100n), true);
    assert.equal(crossedWarn(81n, 1n, 100n), false);
    assert.equal(crossedWarn(100n, 60n, 100n), true);
    assert.equal(crossedWarn(90n, 0n, 100n), false);
    assert.equal(crossedWarn(5n, 5n, 0n), false);
    assert.equal(crossedWarn(50n, 10n, 100n, 50), true);

    const e: NotifyEvent = { type: "budget", agent: "agent-1", spentUsd: "0.82", budgetUsd: "1.00", pct: 82 };
    const t = textOf(e);
    assert.equal(t, "Budget warning: agent-1 has used 82% of its budget, $0.82 of $1.00 in the current window. At 100% its payments stop. Raise it in the console, Agents.");
    assert.equal(/[\n@<>\[\]()`]/.test(textOf({ ...e, agent: "a<@everyone>\n" })), false);

    const net = fake();
    const a = createNotifier(file(), { fetch: net.f });
    a.set({ kind: "webhook", url: "https://h.example/in" });
    a.event(e); a.event({ ...e, pct: 90 });
    a.event({ ...e, agent: "agent-2" });
    await settle();
    assert.equal(net.sent.length, 2);
    assert.equal(net.sent[0]!.body.event.type, "budget");
  });

  it("failures are counted with a short reason and never throw", async () => {
    const down = fake(() => new Response("no", { status: 404 }));
    const a = createNotifier(file(), { fetch: down.f });
    a.set({ kind: "webhook", url: "https://h.example/in" });
    assert.deepEqual(await a.test(), { ok: false, error: "http_404" });
    const dead = createNotifier(file(), { fetch: (async () => { throw new Error("boom https://h.example/in/secret"); }) as typeof fetch });
    dead.set({ kind: "webhook", url: "https://h.example/in/secret" });
    dead.event(refused());
    await settle();
    assert.deepEqual(dead.status(), { kind: "webhook", where: "h.example", sent: 0, failed: 1, last_error: "network" });
  });

  it("textOf: a paused agent and a changed watch, with text from outside cut down to one plain line", () => {
    assert.equal(textOf({ type: "autopause", agent: "agent-1", count: 5 }), "Paused: agent-1 was refused 5 times in a row, so the firewall paused it. Nothing is signed for it until you resume it in the console, Agents.");
    assert.equal(textOf({ type: "changed", agent: "agent-1", task: "river level\n@everyone [x](http://evil)" }), 'Changed: what agent-1 watches, "river level everyone xhttp://evil", is different from the last run. Open the console, Agents, to read it.');
    assert.equal(textOf({ type: "changed", agent: "agent-1", task: "river level", detail: "level is 4.3, above 4" }), 'Watch: agent-1, "river level": level is 4.3, above 4. Open the console, Agents, to read it.');
  });
});
