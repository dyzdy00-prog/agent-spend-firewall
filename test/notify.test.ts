// Owner alerts: target validation, message text, throttling, the private file. No network: fetch is replaced.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createNotifier, MAX_PER_WINDOW, parseTarget, REPEAT_QUIET_S, requestFor, textOf, whereOf } from "../src/notify.ts";
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
});
