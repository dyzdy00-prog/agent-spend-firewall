// First-run setup (`npm start`): files, modes, hashes; an existing config is never touched.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseConfig } from "../src/firewall.ts";
import { ensureSetup, FIRST_AGENT, readAdminToken } from "../src/setup.ts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const template = JSON.parse(fs.readFileSync(path.join(ROOT, "bench", "config.example.json"), "utf8")) as Record<string, any>;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "asf-setup-"));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
const mode = (f: string) => fs.statSync(f).mode & 0o777;

describe("ensureSetup", () => {
  it("creates a private directory, two token files and a config the firewall accepts", () => {
    const dir = path.join(tmpRoot, "a");
    const s = ensureSetup(dir, path.join(dir, "keys"), template);
    assert.equal(s.created, true);
    assert.equal(mode(dir), 0o700);
    for (const f of [s.configPath, s.agentTokenPath, s.adminTokenPath]) assert.equal(mode(f), 0o600, f);
    const raw = JSON.parse(fs.readFileSync(s.configPath, "utf8"));
    const cfg = parseConfig(raw);
    const agent = fs.readFileSync(s.agentTokenPath, "utf8").trim();
    const admin = fs.readFileSync(s.adminTokenPath, "utf8").trim();
    assert.match(agent, /^[0-9a-f]{64}$/);
    assert.notEqual(agent, admin);
    assert.deepEqual(cfg.agents, { [sha(agent)]: FIRST_AGENT });
    assert.equal(cfg.adminTokenSha256, sha(admin));
    assert.deepEqual(cfg.allowPrivateHosts, []);
    assert.equal(cfg.storePath, path.join(dir, "state.db"));
    assert.equal(cfg.logPath, path.join(dir, "decisions.jsonl"));
    assert.equal(readAdminToken(s.adminTokenPath), admin);
  });

  it("writes no token into the config", () => {
    const dir = path.join(tmpRoot, "b");
    const s = ensureSetup(dir, path.join(dir, "keys"), template);
    const text = fs.readFileSync(s.configPath, "utf8");
    assert.equal(text.includes(fs.readFileSync(s.agentTokenPath, "utf8").trim()), false);
    assert.equal(text.includes(fs.readFileSync(s.adminTokenPath, "utf8").trim()), false);
  });

  it("leaves an existing config and existing tokens exactly as they are", () => {
    const dir = path.join(tmpRoot, "c");
    const first = ensureSetup(dir, path.join(dir, "keys"), template);
    const before = [first.configPath, first.agentTokenPath, first.adminTokenPath].map((f) => fs.readFileSync(f, "utf8"));
    const again = ensureSetup(dir, path.join(dir, "other-keys"), template);
    assert.equal(again.created, false);
    assert.deepEqual([again.configPath, again.agentTokenPath, again.adminTokenPath].map((f) => fs.readFileSync(f, "utf8")), before);
  });

  it("reuses an agent token that is already there", () => {
    const dir = path.join(tmpRoot, "d");
    fs.mkdirSync(dir, { mode: 0o700 });
    fs.writeFileSync(path.join(dir, "agent.token"), "an-older-agent-token-0123456789\n", { mode: 0o600 });
    const s = ensureSetup(dir, path.join(dir, "keys"), template);
    assert.deepEqual(parseConfig(JSON.parse(fs.readFileSync(s.configPath, "utf8"))).agents, { [sha("an-older-agent-token-0123456789")]: FIRST_AGENT });
  });

  it("refuses a token file that others can read, and writes no config", () => {
    const dir = path.join(tmpRoot, "e");
    fs.mkdirSync(dir, { mode: 0o700 });
    fs.writeFileSync(path.join(dir, "agent.token"), "an-older-agent-token-0123456789\n", { mode: 0o644 });
    assert.throws(() => ensureSetup(dir, path.join(dir, "keys"), template), /must not be readable/);
    assert.equal(fs.existsSync(path.join(dir, "config.json")), false);
  });

  it("does not change the template it was given", () => {
    const copy = JSON.stringify(template);
    ensureSetup(path.join(tmpRoot, "f"), path.join(tmpRoot, "f", "keys"), template);
    assert.equal(JSON.stringify(template), copy);
  });
});

describe("readAdminToken", () => {
  it("returns null for a missing, loose or malformed file", () => {
    const dir = path.join(tmpRoot, "g");
    fs.mkdirSync(dir);
    assert.equal(readAdminToken(path.join(dir, "none")), null);
    fs.writeFileSync(path.join(dir, "loose"), "a".repeat(64), { mode: 0o644 });
    assert.equal(readAdminToken(path.join(dir, "loose")), null);
    fs.writeFileSync(path.join(dir, "odd"), "not hex at all, with spaces", { mode: 0o600 });
    assert.equal(readAdminToken(path.join(dir, "odd")), null);
  });
});
