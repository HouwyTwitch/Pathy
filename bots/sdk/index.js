// Pathy bot SDK — Telegram-style ergonomics with full E2E crypto.
//
//   import { PathyBot } from '../sdk/index.js';
//   const bot = new PathyBot({ token: process.env.PATHY_BOT_TOKEN });
//   bot.on('message', async (ctx) => ctx.reply(`you said: ${ctx.text}`));
//   await bot.start();
//
// The bot is a first-class E2E participant: it generates its own X-Wing +
// ML-DSA-65 keypair on first run (stored in a local state file), publishes
// only the public bundle, decrypts incoming messages locally and signs +
// encrypts everything it sends. The server never sees bot plaintext either.
import { EventEmitter } from 'node:events';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import * as C from '../../shared/crypto.js';

export class PathyBot extends EventEmitter {
  constructor({ token, baseUrl, stateFile } = {}) {
    super();
    this.token = token || process.env.PATHY_BOT_TOKEN;
    if (!this.token) throw new Error('PathyBot needs a token (PATHY_BOT_TOKEN)');
    this.baseUrl = (baseUrl || process.env.PATHY_BASE_URL || 'http://localhost:8080').replace(/\/$/, '');
    this.stateFile = resolve(stateFile || process.env.PATHY_BOT_STATE || './pathy-bot-state.json');
    this.me = null;
    this.convs = new Map();    // convId -> { id, type, name, scope, keyVersion, myRole, members }
    this.keys = new Map();     // convId -> Map(keyVersion -> Uint8Array)
    this.bundles = new Map();  // ref -> { keys|null }
    this.offset = 0;
    this.running = false;
  }

  // ------------------------------------------------------------ transport

  async api(method, path, body) {
    const res = await fetch(`${this.baseUrl}/botapi/${this.token}${path}`, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error(data?.error || `http ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // ---------------------------------------------------------------- state

  loadState() {
    try {
      const s = JSON.parse(readFileSync(this.stateFile, 'utf8'));
      this.offset = s.offset || 0;
      return C.keysFromSeeds(C.fromB64(s.kemSeed), C.fromB64(s.dsaSeed));
    } catch {
      return null;
    }
  }

  saveState() {
    mkdirSync(dirname(this.stateFile), { recursive: true });
    writeFileSync(this.stateFile, JSON.stringify({
      kemSeed: C.toB64(this.identity.kemSeed),
      dsaSeed: C.toB64(this.identity.dsaSeed),
      offset: this.offset,
    }), { mode: 0o600 });
  }

  // ---------------------------------------------------------------- setup

  async init() {
    this.me = await this.api('GET', '/getMe');
    this.identity = this.loadState();
    if (!this.identity) {
      this.identity = C.generateIdentity();
      this.saveState();
    }
    if (!this.me.hasKeys) {
      await this.api('POST', '/setBundle', {
        pubBundle: C.makePublicBundle(this.identity, this.me.ref),
      });
      this.me.hasKeys = true;
    }
    await this.refreshConversations();
    return this.me;
  }

  async refreshConversations() {
    const { conversations } = await this.api('GET', '/conversations');
    for (const c of conversations) this.convs.set(c.id, c);
  }

  // --------------------------------------------------------------- crypto

  // Envelopes bind to the conversation scope; for DMs, recompute it locally
  // so the server can't remap keys between chats.
  scopeOf(conv) {
    if (conv.type === 'dm') {
      const refs = (conv.members || []).map((m) => m.ref);
      if (refs.length !== 2) throw new Error('malformed dm');
      const expected = C.dmScope(refs[0], refs[1]);
      if (conv.scope !== expected) throw new Error('dm scope mismatch');
      return expected;
    }
    return conv.scope;
  }

  async getBundle(ref) {
    if (this.bundles.has(ref)) return this.bundles.get(ref);
    const res = await this.api('GET', `/bundles/${encodeURIComponent(ref)}`);
    const entry = { keys: C.verifyPublicBundle(res.bundle, ref), bundle: res.bundle };
    this.bundles.set(ref, entry);
    return entry;
  }

  async loadKeys(convId) {
    const conv = this.convs.get(convId);
    if (!conv) throw new Error(`unknown conversation ${convId}`);
    const scope = this.scopeOf(conv);
    const { envelopes } = await this.api('GET', `/conversations/${convId}/envelopes`);
    if (!this.keys.has(convId)) this.keys.set(convId, new Map());
    const cache = this.keys.get(convId);
    for (const { keyVersion, payload } of envelopes) {
      if (cache.has(keyVersion)) continue;
      try {
        const signer = await this.getBundle(payload.from);
        if (!signer.keys) throw new Error(`unverifiable signer ${payload.from}`);
        cache.set(keyVersion, C.unwrapKey(payload, scope, keyVersion, this.me.ref, this.identity, signer.keys.dsa));
      } catch (err) {
        this.emit('error', new Error(`envelope v${keyVersion} conv ${convId}: ${err.message}`));
      }
    }
    return cache;
  }

  async getKey(convId, version) {
    let key = this.keys.get(convId)?.get(version);
    if (!key) {
      if (!this.convs.has(convId)) await this.refreshConversations();
      key = (await this.loadKeys(convId)).get(version);
    }
    return key || null;
  }

  // ------------------------------------------------------------ messaging

  async sendMessage(convId, text, body = {}) {
    const attempt = async () => {
      const conv = this.convs.get(convId);
      if (!conv) throw new Error(`unknown conversation ${convId}`);
      const key = await this.getKey(convId, conv.keyVersion);
      if (!key) throw new Error(`no key v${conv.keyVersion} for conversation ${convId}`);
      const m = C.encryptMessage(key, convId, conv.keyVersion, this.me.ref, this.identity, {
        t: 'text', text, ts: Date.now(), ...body,
      });
      return this.api('POST', '/sendMessage', { convId, ...m });
    };
    try {
      return await attempt();
    } catch (err) {
      if (err.status === 409) { // key rotated — refresh and retry once
        await this.refreshConversations();
        await this.loadKeys(convId);
        return attempt();
      }
      throw err;
    }
  }

  async decrypt(convId, msg) {
    const key = await this.getKey(convId, msg.keyVersion);
    if (!key) throw new Error('no key for message');
    let senderDsa = null;
    try {
      senderDsa = (await this.getBundle(msg.senderRef)).keys?.dsa || null;
    } catch { /* leave unverified */ }
    return C.decryptMessage(key, convId, msg, senderDsa);
  }

  // ----------------------------------------------------------- update loop

  async handleUpdate(u) {
    const ev = u.payload;
    if (ev.type === 'message') {
      if (ev.message.senderRef === this.me.ref) return;
      if (!this.convs.has(ev.convId)) await this.refreshConversations();
      const conv = this.convs.get(ev.convId);
      if (!conv) return;
      let dec;
      try {
        dec = await this.decrypt(ev.convId, ev.message);
      } catch (err) {
        this.emit('error', new Error(`cannot decrypt message in conv ${ev.convId}: ${err.message}`));
        return;
      }
      this.emit('message', {
        conv,
        senderRef: ev.message.senderRef,
        verified: dec.verified,
        body: dec.body,
        text: dec.body?.text ?? '',
        reply: (text, body) => this.sendMessage(conv.id, text, body),
      });
    } else if (ev.type === 'envelope') {
      await this.refreshConversations();
      if (this.convs.has(ev.convId)) await this.loadKeys(ev.convId);
    } else if (ev.type === 'conv' || ev.type === 'member') {
      await this.refreshConversations();
      const convId = ev.convId ?? ev.conversation?.id;
      if (ev.type === 'member' && ev.action === 'add' && ev.ref === this.me.ref) {
        this.emit('joined', this.convs.get(convId));
      }
    }
  }

  async start() {
    await this.init();
    this.running = true;
    this.emit('ready', this.me);
    while (this.running) {
      try {
        const { updates } = await this.api('GET', `/getUpdates?offset=${this.offset}&timeout=25`);
        for (const u of updates) {
          this.offset = Number(u.updateId) + 1;
          try {
            await this.handleUpdate(u);
          } catch (err) {
            this.emit('error', err);
          }
        }
        if (updates.length > 0) this.saveState();
      } catch (err) {
        this.emit('error', err);
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }

  stop() {
    this.running = false;
  }
}
