// Owner alerts: target validation, message text, throttling, the private file. No network: fetch is replaced.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { heldText, inQuiet, parseQuiet, BUDGET_WARN_PCT, createNotifier, crossedWarn, dueDay, MAX_PER_WINDOW, parseTarget, REPEAT_QUIET_S, requestFor, summaryText, textOf, whereOf } from "../src/notify.ts";
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
    assert.deepEqual(a.status(), { kind: "discord", where: "discord.com", sent: 0, failed: 0, last_error: null, quiet: null, held: 0, summaries: ["daily", "weekly", "monthly"] });
    // The owner's choice of regular summaries: checked, and kept in a fixed order.
    assert.match(a.setSummaries(["hourly"]) ?? "", /^summaries: /);
    assert.match(a.setSummaries(["daily", "daily"]) ?? "", /^summaries: /);
    assert.match(a.setSummaries("daily") ?? "", /^summaries: /);
    assert.equal(a.setSummaries(["monthly", "daily"]), null);
    assert.deepEqual(a.status()?.summaries, ["daily", "monthly"]);
    // The choice is a file of its own (0600), read by the next process; a file that is not a valid list means all three.
    const sumFile = f.replace(/\.json$/, "") + "-summaries.json";
    assert.equal(fs.statSync(sumFile).mode & 0o777, 0o600);
    assert.deepEqual(createNotifier(f, { fetch: net.f }).status()?.summaries, ["daily", "monthly"]);
    fs.writeFileSync(sumFile, '["hourly"]', { mode: 0o600 });
    assert.deepEqual(createNotifier(f, { fetch: net.f }).status()?.summaries, ["daily", "weekly", "monthly"]);
    fs.writeFileSync(sumFile, "[]", { mode: 0o600 });
    assert.deepEqual(createNotifier(f, { fetch: net.f }).status()?.summaries, []);
    assert.equal(a.setSummaries(["daily", "weekly", "monthly"]), null);
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
    // The weekly message names the week before it.
    assert.equal(summaryText({ ...s, hours: 168, before: { requests: 66, paidUsd: "0.55" } }), "Last 7 days: 12 requests. 9 payments, $0.18; 3 stopped; 2 served from cache, $0.04 saved. The week before: 66 requests, $0.55 paid. Details: the console, Report.");
    assert.equal(summaryText({ ...s, hours: 168, requests: 0, before: { requests: 1, paidUsd: "0.01" } }), "Last 7 days: no requests from your agents. The week before: 1 request, $0.01 paid.");
    assert.ok(summaryText({ ...s, hours: 168, before: { requests: 0, paidUsd: "0" } }).includes(" The week before: no requests. "));
    assert.equal(summaryText({ ...s, hours: 720, before: { requests: 3, paidUsd: "0.03" } }), "Last 30 days: 12 requests. 9 payments, $0.18; 3 stopped; 2 served from cache, $0.04 saved. The 30 days before: 3 requests, $0.03 paid. Details: the console, Report.");
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

  it("the log: every message with its outcome, newest first, kept in a 0600 file a new notifier reads", async () => {
    const f = file(), net = fake(), logFile = f.replace(/\.json$/, "") + "-log.jsonl";
    let t = 5000;
    const a = createNotifier(f, { fetch: net.f, now: () => t });
    assert.deepEqual(a.log(), []);
    a.event(refused());
    await settle();
    assert.deepEqual(a.log(), [], "alerts are off: nothing is sent and nothing is logged");
    a.set({ kind: "webhook", url: "https://h.example/in/secret" });
    a.event({ type: "changed", agent: "a", task: "river | level > 4", detail: "level is 4.3, above 4" });
    await settle();
    t = 5060;
    assert.deepEqual(await a.test(), { ok: true });
    const log = a.log();
    assert.deepEqual(log.map((x) => [x.ts, x.type, x.ok, x.agent, x.task]), [[5060, "test", true, undefined, undefined], [5000, "changed", true, "a", "river | level > 4"]]);
    assert.ok(log[1]!.text.includes("4.3"));
    assert.equal(fs.statSync(logFile).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(logFile, "utf8").includes("secret"), false);

    const down = createNotifier(f, { fetch: fake(() => new Response("no", { status: 404 })).f, now: () => 5100, retryMs: 0 });
    assert.equal(down.log().length, 2, "read back from the file");
    down.event(refused());
    await settle();
    assert.deepEqual(down.log()[0]!.tries, 2);
    assert.deepEqual(down.log().map((x) => [x.type, x.ok, x.error]), [["refused", false, "http_404"], ["test", true, undefined], ["changed", true, undefined]]);
    fs.chmodSync(logFile, 0o644);
    assert.deepEqual(createNotifier(f, { fetch: net.f }).log(), [], "a log others can read is not trusted");
  });

  it("an event that fails is sent once more; a test message is not; a channel switched off meanwhile gets nothing", async () => {
    let calls = 0;
    const flaky = (async () => { calls++; return new Response("x", { status: calls === 1 ? 503 : 200 }); }) as typeof fetch;
    const a = createNotifier(file(), { fetch: flaky, retryMs: 5 });
    a.set({ kind: "webhook", url: "https://h.example/in" });
    a.event(refused());
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(calls, 2);
    assert.deepEqual(a.log().map((x) => [x.ok, x.tries, x.error]), [[true, 2, undefined]]);
    assert.deepEqual([a.status()!.sent, a.status()!.failed], [1, 0]);

    let n = 0;
    const down = (async () => { n++; return new Response("x", { status: 500 }); }) as typeof fetch;
    const b = createNotifier(file(), { fetch: down, retryMs: 5 });
    b.set({ kind: "webhook", url: "https://h.example/in" });
    assert.deepEqual(await b.test(), { ok: false, error: "http_500" });
    assert.equal(n, 1, "the owner sees a failed test at once");
    b.event(refused());
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(n, 3);
    assert.deepEqual(b.log()[0], { ts: b.log()[0]!.ts, type: "refused", text: b.log()[0]!.text, ok: false, tries: 2, agent: "agent-1", host: b.log()[0]!.host, error: "http_500" });

    let m = 0;
    const c = createNotifier(file(), { fetch: (async () => { m++; return new Response("x", { status: 500 }); }) as typeof fetch, retryMs: 20 });
    c.set({ kind: "webhook", url: "https://h.example/in" });
    c.event(refused());
    await settle();
    c.clear();
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(m, 1);
  });

  it("quiet hours: events are held and logged, then told in one message when the hours end", async () => {
    assert.deepEqual([22, 23, 0, 6, 7, 12].map((h) => inQuiet(h, { from: 22, to: 7 })), [true, true, true, true, false, false]);
    assert.deepEqual([8, 9, 16, 17].map((h) => inQuiet(h, { from: 9, to: 17 })), [false, true, true, false]);
    assert.equal(inQuiet(3, null), false);
    assert.deepEqual(parseQuiet({ from: 22, to: 7 }), { from: 22, to: 7 });
    assert.equal(parseQuiet(null), null);
    for (const bad of [{ from: 7, to: 7 }, { from: 24, to: 1 }, { from: 1.5, to: 3 }, { from: "22", to: 7 }, { from: 1 }, { from: 1, to: 2, x: 1 }, "night"]) assert.ok("error" in (parseQuiet(bad) as object), JSON.stringify(bad));
    assert.equal(heldText({ refused: 2, changed: 1 }), "While alerts were quiet: 2 payments stopped, 1 watch changed. Open the console, Rules, to read them.");

    const f = file(), net = fake();
    let h = 23;
    const a = createNotifier(f, { fetch: net.f, hour: () => h, retryMs: 0 });
    a.set({ kind: "webhook", url: "https://h.example/in" });
    assert.equal(a.setQuiet({ from: 22, to: 7 }), null);
    assert.equal(fs.statSync(f.replace(/\.json$/, "") + "-quiet.json").mode & 0o777, 0o600);
    a.event(refused());
    a.event({ type: "changed", agent: "a", task: "river" });
    a.event({ type: "approval", agent: "a", host: "h.example", usd: "0.40", waitS: 120 });
    await settle();
    assert.equal(net.sent.length, 0, "nothing leaves during the quiet hours");
    assert.deepEqual(a.log().map((x) => [x.type, x.ok, x.error]), [["approval", false, "held"], ["changed", false, "held"], ["refused", false, "held"]]);
    assert.deepEqual([a.status()!.held, a.status()!.failed, a.status()!.quiet], [3, 0, { from: 22, to: 7 }]);
    assert.equal(await a.flush(), false, "still quiet");
    h = 7;
    assert.equal(await a.flush(), true);
    assert.deepEqual(net.sent.map((x) => x.body.text), ["While alerts were quiet: 1 payment waited for you, 1 payment stopped, 1 watch changed. Open the console, Rules, to read them."]);
    assert.equal(await a.flush(), false, "told once");
    a.event(refused({ agent: "b" }));
    await settle();
    assert.equal(net.sent.length, 2, "outside the hours an event goes out at once");

    const b = createNotifier(f, { fetch: net.f, hour: () => 23 });
    assert.deepEqual(b.status()!.quiet, { from: 22, to: 7 }, "read back from the file");
    assert.equal(b.setQuiet({ from: 3, to: 3 }) !== null, true);
    assert.equal(b.setQuiet(null), null);
    assert.equal(createNotifier(f, { fetch: net.f }).status()!.quiet, null);
  });

  it("one agent's own channel: its events go there, the others and the test message stay on the main one", async () => {
    const f = file(), net = fake();
    const a = createNotifier(f, { fetch: net.f });
    assert.equal(a.forAgent("agent-1"), null);
    assert.ok(a.setFor("agent-1", { kind: "webhook", url: "ftp://x" }) !== null);
    assert.equal(a.setFor("agent-1", { kind: "webhook", url: "https://one.example/in/secret" }), null);
    assert.deepEqual(a.forAgent("agent-1"), { kind: "webhook", where: "one.example" });
    const agentsFile = f.replace(/\.json$/, "") + "-agents.json";
    assert.equal(fs.statSync(agentsFile).mode & 0o777, 0o600);
    a.event(refused());
    a.event(refused({ agent: "agent-2" }));
    await settle();
    assert.deepEqual(net.sent.map((x) => new URL(x.url).host), ["one.example"], "the main channel is off: only the agent with its own is told");
    a.set({ kind: "webhook", url: "https://main.example/in" });
    a.event(refused({ agent: "agent-2" }));
    a.event(refused({ code: "BUDGET" }));
    await a.test();
    assert.deepEqual(net.sent.slice(1).map((x) => new URL(x.url).host).sort(), ["main.example", "main.example", "one.example"]);
    assert.deepEqual(createNotifier(f, { fetch: net.f }).forAgent("agent-1"), { kind: "webhook", where: "one.example" }, "read back from the file");
    assert.equal(a.setFor("agent-1", null), null);
    assert.equal(fs.existsSync(agentsFile), false);
    assert.equal(a.forAgent("agent-1"), null);
  });

  it("failures are counted with a short reason and never throw", async () => {
    const down = fake(() => new Response("no", { status: 404 }));
    const a = createNotifier(file(), { fetch: down.f });
    a.set({ kind: "webhook", url: "https://h.example/in" });
    assert.deepEqual(await a.test(), { ok: false, error: "http_404" });
    const dead = createNotifier(file(), { retryMs: 0, fetch: (async () => { throw new Error("boom https://h.example/in/secret"); }) as typeof fetch });
    dead.set({ kind: "webhook", url: "https://h.example/in/secret" });
    dead.event(refused());
    await settle();
    assert.deepEqual(dead.status(), { kind: "webhook", where: "h.example", sent: 0, failed: 1, last_error: "network", quiet: null, held: 0, summaries: ["daily", "weekly", "monthly"] });
  });

  it("textOf: a paused agent and a changed watch, with text from outside cut down to one plain line", () => {
    assert.equal(textOf({ type: "autopause", agent: "agent-1", count: 5 }), "Paused: agent-1 was refused 5 times in a row, so the firewall paused it. Nothing is signed for it until you resume it in the console, Agents.");
    assert.equal(textOf({ type: "changed", agent: "agent-1", task: "river level\n@everyone [x](http://evil)" }), 'Changed: what agent-1 watches, "river level everyone xhttp://evil", is different from the last run. Open the console, Agents, to read it.');
    assert.equal(textOf({ type: "changed", agent: "agent-1", task: "river level", detail: "level is 4.3, above 4" }), 'Watch: agent-1, "river level": level is 4.3, above 4. Open the console, Agents, to read it.');
  });
});
