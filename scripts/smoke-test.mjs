// End-to-end smoke test against a running Pathy server (default
// http://localhost:8080; override with PATHY_BASE_URL).
//
//   node scripts/smoke-test.mjs
//
// Simulates real clients: every user/bot does actual client-side crypto via
// shared/crypto.js — nothing here bypasses E2E.
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import * as C from '../shared/crypto.js';
import { PathyBot } from '../bots/sdk/index.js';

const BASE = process.env.PATHY_BASE_URL || 'http://localhost:8080';
const run = Math.random().toString(36).slice(2, 8);
const log = (s) => console.log(`✔ ${s}`);

async function http(method, path, body, token) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

// A minimal in-memory Pathy client mirroring the web app's crypto flows.
class TestUser {
  constructor(name) {
    this.username = `${name}_${run}`;
    this.ref = `u:${this.username}`;
    this.password = `pw-${name}-${run}-longenough`;
    this.keys = C.generateIdentity();
    this.convKeys = new Map();
    this.bundles = new Map();
  }

  async register() {
    const salt = C.newSalt();
    const { authKey, backupKey } = C.deriveLoginKeys(this.password, salt);
    this.backupKey = backupKey;
    const r = await http('POST', '/api/register', {
      username: this.username, salt, authKey,
      pubBundle: C.makePublicBundle(this.keys, this.ref),
      backup: C.encryptBackup(backupKey, this.keys, this.username),
    });
    assert.equal(r.status, 201, `register ${this.username}: ${JSON.stringify(r.data)}`);
    this.token = r.data.token;
  }

  async login() {
    const s = await http('POST', '/api/login/salt', { username: this.username });
    const { authKey, backupKey } = C.deriveLoginKeys(this.password, s.data.salt);
    const r = await http('POST', '/api/login', { username: this.username, authKey });
    assert.equal(r.status, 200, 'login');
    this.token = r.data.token;
    const restored = C.decryptBackup(backupKey, r.data.backup, this.username);
    assert.deepEqual(restored.dsaPublic, this.keys.dsaPublic, 'backup restores same identity');
    return r.data;
  }

  async api(method, path, body) {
    return http(method, path, body, this.token);
  }

  async bundleOf(ref) {
    if (this.bundles.has(ref)) return this.bundles.get(ref);
    const r = await this.api('GET', `/api/bundles/${encodeURIComponent(ref)}`);
    assert.equal(r.status, 200, `bundle ${ref}`);
    const keys = C.verifyPublicBundle(r.data.bundle, ref);
    assert.ok(keys, `bundle of ${ref} verifies`);
    this.bundles.set(ref, keys);
    return keys;
  }

  scopeOf(conv) {
    if (conv.type === 'dm') {
      const refs = conv.members.map((m) => m.ref);
      const expected = C.dmScope(refs[0], refs[1]);
      assert.equal(conv.scope, expected, 'dm scope must match member refs');
      return expected;
    }
    return conv.scope;
  }

  async loadKeys(conv) {
    const scope = this.scopeOf(conv);
    const r = await this.api('GET', `/api/conversations/${conv.id}/envelopes`);
    assert.equal(r.status, 200);
    if (!this.convKeys.has(conv.id)) this.convKeys.set(conv.id, new Map());
    const cache = this.convKeys.get(conv.id);
    for (const { keyVersion, payload } of r.data.envelopes) {
      if (cache.has(keyVersion)) continue;
      const signer = await this.bundleOf(payload.from);
      cache.set(keyVersion, C.unwrapKey(payload, scope, keyVersion, this.ref, this.keys, signer.dsa));
    }
    return cache;
  }

  async startDm(peerRef) {
    const peer = await this.bundleOf(peerRef);
    const key = C.newConversationKey();
    const scope = C.dmScope(this.ref, peerRef);
    const r = await this.api('POST', '/api/conversations', {
      type: 'dm', peerRef,
      envelopes: {
        [this.ref]: [{ keyVersion: 1, payload: C.wrapKey(key, scope, 1, this.ref, this.keys.kemPublic, this.ref, this.keys) }],
        [peerRef]: [{ keyVersion: 1, payload: C.wrapKey(key, scope, 1, peerRef, peer.kem, this.ref, this.keys) }],
      },
    });
    if (r.status === 201 || (r.status === 200 && r.data.existing)) {
      if (r.status === 201) {
        this.convKeys.set(r.data.conversation.id, new Map([[1, key]]));
      }
      return r.data.conversation;
    }
    const err = new Error(r.data?.error || `dm failed ${r.status}`);
    err.status = r.status;
    throw err;
  }

  async createRoom(type, name) {
    const key = C.newConversationKey();
    const scope = `room:${crypto.randomUUID()}`;
    const r = await this.api('POST', '/api/conversations', {
      type, name, scope,
      envelopes: { [this.ref]: [{ keyVersion: 1, payload: C.wrapKey(key, scope, 1, this.ref, this.keys.kemPublic, this.ref, this.keys) }] },
    });
    assert.equal(r.status, 201, `create ${type}: ${JSON.stringify(r.data)}`);
    this.convKeys.set(r.data.conversation.id, new Map([[1, key]]));
    return r.data.conversation;
  }

  async invite(conv, ref, role = 'member') {
    const scope = this.scopeOf(conv);
    const target = await this.bundleOf(ref);
    const keys = await this.loadKeys(conv);
    const envelopes = [...keys.entries()].map(([v, k]) => ({
      keyVersion: v, payload: C.wrapKey(k, scope, v, ref, target.kem, this.ref, this.keys),
    }));
    return this.api('POST', `/api/conversations/${conv.id}/members`, { ref, role, envelopes });
  }

  async rotate(conv) {
    const fresh = (await this.api('GET', `/api/conversations/${conv.id}`)).data.conversation;
    const scope = this.scopeOf(fresh);
    const v = fresh.keyVersion + 1;
    const key = C.newConversationKey();
    const envelopes = {};
    for (const m of fresh.members) {
      const t = await this.bundleOf(m.ref);
      envelopes[m.ref] = C.wrapKey(key, scope, v, m.ref, t.kem, this.ref, this.keys);
    }
    const r = await this.api('POST', `/api/conversations/${conv.id}/rotate`, { keyVersion: v, envelopes });
    assert.equal(r.status, 200, `rotate: ${JSON.stringify(r.data)}`);
    this.convKeys.get(conv.id)?.set(v, key);
    conv.keyVersion = v;
    return v;
  }

  async send(conv, text) {
    const keys = await this.loadKeys(conv);
    const key = keys.get(conv.keyVersion);
    assert.ok(key, `have key v${conv.keyVersion}`);
    const m = C.encryptMessage(key, conv.id, conv.keyVersion, this.ref, this.keys, { t: 'text', text, ts: Date.now() });
    return this.api('POST', `/api/conversations/${conv.id}/messages`, m);
  }

  async read(convId) {
    const conv = (await this.api('GET', `/api/conversations/${convId}`)).data.conversation;
    const keys = await this.loadKeys(conv);
    const r = await this.api('GET', `/api/conversations/${convId}/messages`);
    assert.equal(r.status, 200);
    const out = [];
    for (const m of r.data.messages) {
      const key = keys.get(m.keyVersion);
      if (!key) { out.push({ senderRef: m.senderRef, error: 'no key' }); continue; }
      const sender = await this.bundleOf(m.senderRef);
      out.push({ senderRef: m.senderRef, ...C.decryptMessage(key, convId, m, sender.dsa) });
    }
    return out;
  }
}

// ------------------------------------------------------------------- tests

const alice = new TestUser('alice');
const bob = new TestUser('bob');
const carol = new TestUser('carol');

await alice.register();
await bob.register();
await carol.register();
log('registered alice, bob, carol (client-side keygen, scrypt auth, encrypted backups)');

await bob.login();
log('bob re-login: salt fetch → scrypt → auth, key backup decrypted and matches');

// --- search + DM
const search = await alice.api('GET', `/api/users/search?q=bob_${run.slice(0, 4)}`);
assert.ok(search.data.results.some((r2) => r2.ref === bob.ref), 'bob found in search');

const dm = await alice.startDm(bob.ref);
assert.equal(dm.type, 'dm');
await alice.send(dm, 'hello bob, PQC works 🚀');

// bob receives via WS push while we also check history
const wsEvent = new Promise((resolve, reject) => {
  const ws = new WebSocket(`${BASE.replace('http', 'ws')}/ws`);
  const timer = setTimeout(() => reject(new Error('ws timeout')), 8000);
  ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token: bob.token })));
  ws.on('message', (d) => {
    const ev = JSON.parse(d.toString());
    if (ev.type === 'message') { clearTimeout(timer); ws.close(); resolve(ev); }
  });
  ws.on('error', reject);
});

const bobConvs = (await bob.api('GET', '/api/conversations')).data.conversations;
const bobDm = bobConvs.find((c) => c.id === dm.id);
assert.ok(bobDm, 'bob sees the dm');
let msgs = await bob.read(dm.id);
assert.equal(msgs[0].body.text, 'hello bob, PQC works 🚀');
assert.equal(msgs[0].verified, true, 'alice signature verified');
log('DM: alice → bob, X-Wing envelope unwrap + XChaCha decrypt + ML-DSA verify OK');

await bob.send(bobDm, 'hi alice!');
const wsEv = await wsEvent; // bob got alice's or his own echo — both fine
assert.equal(wsEv.type, 'message');
log('WebSocket push delivered message event');

msgs = await alice.read(dm.id);
assert.equal(msgs.at(-1).body.text, 'hi alice!');
log('DM: bob → alice roundtrip OK');

// --- privacy settings
let r = await bob.api('PUT', '/api/me/settings', { whoCanDm: 'nobody' });
assert.equal(r.data.settings.whoCanDm, 'nobody');
await assert.rejects(carol.startDm(bob.ref), (e) => e.status === 403, 'whoCanDm=nobody blocks strangers');

await bob.api('PUT', '/api/me/settings', { whoCanDm: 'contacts' });
await assert.rejects(carol.startDm(bob.ref), (e) => e.status === 403, 'whoCanDm=contacts blocks carol');
const dmAgain = await alice.startDm(bob.ref); // existing conversation → allowed
assert.equal(dmAgain.id, dm.id, 'existing dm returned, not duplicated');

r = await bob.api('PUT', '/api/me/settings', { discoverable: false });
const s1 = await carol.api('GET', `/api/users/search?q=bob_${run.slice(0, 4)}`);
assert.ok(!s1.data.results.some((x) => x.ref === bob.ref), 'undiscoverable: prefix search hides bob');
const s2 = await carol.api('GET', `/api/users/search?q=${bob.username}`);
assert.ok(s2.data.results.some((x) => x.ref === bob.ref), 'exact username still finds bob');
await bob.api('PUT', '/api/me/settings', { whoCanDm: 'everyone', discoverable: true });
log('privacy settings: whoCanDm nobody/contacts + discoverability enforced');

// --- channel (broadcast) + group
const channel = await alice.createRoom('channel', `news-${run}`);
r = await alice.invite(channel, bob.ref);
assert.equal(r.status, 201, `invite bob: ${JSON.stringify(r.data)}`);
await alice.send(channel, 'welcome to the channel 📢');
channel.members = (await alice.api('GET', `/api/conversations/${channel.id}`)).data.conversation.members;

msgs = await bob.read(channel.id);
assert.equal(msgs[0].body.text, 'welcome to the channel 📢');
const bobChannel = (await bob.api('GET', '/api/conversations')).data.conversations.find((c) => c.id === channel.id);
r = await bob.send(bobChannel, 'can I post?');
assert.equal(r.status, 403, 'non-admin cannot post in channel');
log('channel: invite + broadcast works, member posting blocked (admins only)');

// whoCanAdd
await carol.api('PUT', '/api/me/settings', { whoCanAdd: 'nobody' });
r = await alice.invite(channel, carol.ref);
assert.equal(r.status, 403, 'whoCanAdd=nobody blocks channel invites');
await carol.api('PUT', '/api/me/settings', { whoCanAdd: 'everyone' });
log('privacy: whoCanAdd enforced for channel invites');

const group = await alice.createRoom('group', `friends-${run}`);
await alice.invite(group, bob.ref);
await alice.invite(group, carol.ref);
const bobGroup = (await bob.api('GET', '/api/conversations')).data.conversations.find((c) => c.id === group.id);
r = await bob.send(bobGroup, 'groups let everyone post');
assert.equal(r.status, 201, 'group member can post');
msgs = await carol.read(group.id);
assert.ok(msgs.some((m) => m.body?.text === 'groups let everyone post'), 'carol reads group history');
log('group: members post, history readable by invitees');

// --- removal + key rotation
r = await alice.api('DELETE', `/api/conversations/${group.id}/members/${encodeURIComponent(carol.ref)}`);
assert.equal(r.status, 200);
await alice.rotate(group);
r = await carol.api('GET', `/api/conversations/${group.id}/messages`);
assert.equal(r.status, 403, 'removed member has no API access');
await alice.send(group, 'carol cannot read this (v2 key)');
msgs = await bob.read(group.id);
assert.equal(msgs.at(-1).body.text, 'carol cannot read this (v2 key)');
assert.equal(msgs.at(-1).verified, true);
log('remove + rotate: bob got v2 via envelope, carol locked out');

// stale key version rejected
const staleKeys = alice.convKeys.get(group.id);
const staleMsg = C.encryptMessage(staleKeys.get(1), group.id, 1, alice.ref, alice.keys, { t: 'text', text: 'stale' });
r = await alice.api('POST', `/api/conversations/${group.id}/messages`, staleMsg);
assert.equal(r.status, 409, 'stale key version rejected');
log('server rejects messages encrypted under rotated-out key versions');

// --- tamper detection
const rawMsgs = (await alice.api('GET', `/api/conversations/${group.id}/messages`)).data.messages;
const last = rawMsgs.at(-1);
const groupKeys = await bob.loadKeys(bobGroup);
const tampered = { ...last, ct: last.ct.slice(0, -4) + (last.ct.endsWith('AAAA') ? 'BBBB' : 'AAAA') };
assert.throws(
  () => C.decryptMessage(groupKeys.get(tampered.keyVersion), group.id, tampered, null),
  'tampered ciphertext fails AEAD',
);
log('tampered ciphertext rejected by AEAD');

// --- bots
r = await alice.api('POST', '/api/bots', { username: `echo_${run}bot` });
assert.equal(r.status, 201, `create bot: ${JSON.stringify(r.data)}`);
const botToken = r.data.token;
const botRef = r.data.ref;

const bot = new PathyBot({
  token: botToken,
  baseUrl: BASE,
  stateFile: `${process.env.TMPDIR || '/tmp'}/pathy-smoke-bot-${run}.json`,
});
bot.on('message', async (ctx) => {
  await ctx.reply(`echo: ${ctx.text}`);
});
bot.on('error', (e) => console.error('  bot error:', e.message));
const botDone = bot.start();

// wait until the bot has published keys
for (let i = 0; i < 50; i++) {
  const b = await http('GET', `/botapi/${botToken}/getMe`);
  if (b.data.hasKeys) break;
  await new Promise((res2) => setTimeout(res2, 200));
}

const botDm = await alice.startDm(botRef);
await alice.send(botDm, 'ping through pqc');

let echoed = null;
for (let i = 0; i < 60 && !echoed; i++) {
  await new Promise((res2) => setTimeout(res2, 500));
  const list = await alice.read(botDm.id);
  echoed = list.find((m) => m.senderRef === botRef && m.body?.text === 'echo: ping through pqc');
}
assert.ok(echoed, 'bot echoed the DM');
assert.equal(echoed.verified, true, 'bot signature verified');
log('bot: E2E DM → decrypt → signed encrypted reply, verified by alice');

// bot in a channel as admin (posting rights)
await alice.invite(channel, botRef, 'admin');
let botInChannel = null;
for (let i = 0; i < 40 && !botInChannel; i++) {
  await new Promise((res2) => setTimeout(res2, 500));
  const list = await bob.read(channel.id);
  botInChannel = list.find((m) => m.senderRef === botRef && m.body?.text === 'echo: bot, say hi to the channel');
  if (!botInChannel) {
    const fresh = (await alice.api('GET', `/api/conversations/${channel.id}`)).data.conversation;
    if (i === 0) await alice.send(fresh, 'bot, say hi to the channel');
  }
}
assert.ok(botInChannel, 'admin bot echoed into the channel');
log('bot: joined channel as admin, echoed encrypted broadcast');

bot.stop();
await Promise.race([botDone, new Promise((res2) => setTimeout(res2, 1000))]);

// --- non-member access denied
r = await carol.api('GET', `/api/conversations/${channel.id}/messages`);
assert.equal(r.status, 403, 'non-member blocked');

console.log('\nALL SMOKE TESTS PASSED 🎉');
process.exit(0);
