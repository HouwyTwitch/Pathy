// API tests for features added after the initial release: chunked 2GB-capable blobs, sticker packs, typing.
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import * as C from '../shared/crypto.js';

const BASE = 'http://localhost:8080';
const run = Math.random().toString(36).slice(2, 8);
const log = (s) => console.log(`✔ ${s}`);

async function http(method, path, body, token, raw = false, contentType = null) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body !== undefined && !raw ? { 'content-type': 'application/json' } : {}),
      ...(raw ? { 'content-type': contentType || 'application/octet-stream' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? (raw ? body : JSON.stringify(body)) : undefined,
  });
  let data = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('json')) data = await res.json().catch(() => null);
  else data = new Uint8Array(await res.arrayBuffer());
  return { status: res.status, data, res };
}

async function mkUser(name) {
  const username = `${name}_${run}`;
  const keys = C.generateIdentity();
  const salt = C.newSalt();
  const { authKey, backupKey } = C.deriveLoginKeys(`pw-${name}-longenough`, salt);
  const r = await http('POST', '/api/register', {
    username, salt, authKey,
    pubBundle: C.makePublicBundle(keys, `u:${username}`),
    backup: C.encryptBackup(backupKey, keys, username),
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return { username, ref: `u:${username}`, keys, token: r.data.token };
}

const a = await mkUser('ann');
const b = await mkUser('ben');
log('registered test users');

// DM
const scope = C.dmScope(a.ref, b.ref);
const key = C.newConversationKey();
const bBundle = C.verifyPublicBundle((await http('GET', `/api/bundles/${encodeURIComponent(b.ref)}`, undefined, a.token)).data.bundle, b.ref);
const dm = await http('POST', '/api/conversations', {
  type: 'dm', peerRef: b.ref,
  envelopes: {
    [a.ref]: [{ keyVersion: 1, payload: C.wrapKey(key, scope, 1, a.ref, a.keys.kemPublic, a.ref, a.keys) }],
    [b.ref]: [{ keyVersion: 1, payload: C.wrapKey(key, scope, 1, b.ref, bBundle.kem, a.ref, a.keys) }],
  },
}, a.token);
assert.equal(dm.status, 201, JSON.stringify(dm.data));
const convId = dm.data.conversation.id;

// ---- chunked blob upload/download
const CS = 64 * 1024; // use the server minimum chunk for the test
const fileBytes = new Uint8Array(CS * 2 + 12345); // 3 chunks, last partial
for (let i = 0; i < fileBytes.length; i++) fileBytes[i] = (i * 7 + 13) & 0xff;
const blobKey = C.newBlobKey();
const prefix = C.newBlobNoncePrefix();
const total = Math.ceil(fileBytes.length / CS);
const init = await http('POST', `/api/conversations/${convId}/blobs`, { size: fileBytes.length, chunkBytes: CS }, a.token);
assert.equal(init.status, 201, JSON.stringify(init.data));
assert.equal(init.data.chunks, total);
const blobId = init.data.blobId;

// out-of-order chunk must be rejected
const ct1 = C.encryptBlobChunk(blobKey, prefix, 1, total, fileBytes.subarray(CS, 2 * CS));
let r = await http('PUT', `/api/blobs/${blobId}/chunks/1`, ct1, a.token, true);
assert.equal(r.status, 409, 'out-of-order chunk rejected');
// wrong size must be rejected
r = await http('PUT', `/api/blobs/${blobId}/chunks/0`, ct1.slice(0, 100), a.token, true);
assert.equal(r.status, 400, 'wrong-size chunk rejected');
// blob not ready → download blocked
r = await http('GET', `/api/blobs/${blobId}`, undefined, a.token);
assert.equal(r.status, 409, 'incomplete blob not downloadable');

for (let i = 0; i < total; i++) {
  const pt = fileBytes.subarray(i * CS, Math.min(fileBytes.length, (i + 1) * CS));
  const ct = C.encryptBlobChunk(blobKey, prefix, i, total, pt);
  r = await http('PUT', `/api/blobs/${blobId}/chunks/${i}`, ct, a.token, true);
  assert.equal(r.status, 200, `chunk ${i}: ${JSON.stringify(r.data)}`);
}
log('chunked upload: order + size enforced, all chunks accepted');

// stranger cannot download
const c = await mkUser('caz');
r = await http('GET', `/api/blobs/${blobId}`, undefined, c.token);
assert.equal(r.status, 403, 'non-member blocked from blob');

// member downloads + decrypts + integrity
r = await http('GET', `/api/blobs/${blobId}`, undefined, b.token);
assert.equal(r.status, 200);
const dl = r.data;
let off = 0;
const parts = [];
for (let i = 0; i < total; i++) {
  const ptLen = i === total - 1 ? fileBytes.length - (total - 1) * CS : CS;
  parts.push(C.decryptBlobChunk(blobKey, prefix, i, total, dl.subarray(off, off + ptLen + 16)));
  off += ptLen + 16;
}
const joined = new Uint8Array(fileBytes.length);
let o2 = 0;
for (const p of parts) { joined.set(p, o2); o2 += p.length; }
assert.deepEqual(joined, fileBytes, 'roundtrip bytes match');
// swapping two chunks must fail decryption
assert.throws(() => C.decryptBlobChunk(blobKey, prefix, 0, total, dl.subarray(CS + 16, 2 * (CS + 16))));
log('chunked download: decrypts, integrity verified, reorder detected');

// ---- stickers
r = await http('POST', '/api/stickers/packs', { title: `Test pack ${run}` }, a.token);
assert.equal(r.status, 201, JSON.stringify(r.data));
const packId = r.data.pack.id;
// tiny webp (1x1) — real webp header
const webp = Buffer.concat([
  Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '),
  Buffer.alloc(200, 7),
]);
webp.writeUInt32LE(webp.length - 8, 4);
r = await http('POST', `/api/stickers/packs/${packId}/stickers?emoji=%F0%9F%98%80&w=512&h=512`, webp, a.token, true, 'image/webp');
assert.equal(r.status, 201, JSON.stringify(r.data));
const stickerId = r.data.sticker.id;
log('sticker pack created, sticker uploaded');

// b sees the pack & installs it
r = await http('GET', `/api/stickers/packs/${packId}`, undefined, b.token);
assert.equal(r.status, 200);
assert.equal(r.data.pack.installed, false);
assert.equal(r.data.pack.stickers.length, 1);
r = await http('POST', `/api/stickers/packs/${packId}/install`, {}, b.token);
assert.equal(r.status, 201);
r = await http('GET', '/api/stickers/packs', undefined, b.token);
assert.ok(r.data.packs.some((p) => p.id === packId), 'installed pack listed');
// image fetch
r = await http('GET', `/api/stickers/sticker/${stickerId}/image`, undefined, b.token);
assert.equal(r.status, 200);
assert.equal(r.data.length, webp.length);
// non-owner cannot add stickers
r = await http('POST', `/api/stickers/packs/${packId}/stickers`, webp, b.token, true, 'image/webp');
assert.equal(r.status, 403);
// uninstall (non-owner) keeps the pack
r = await http('DELETE', `/api/stickers/packs/${packId}`, undefined, b.token);
assert.equal(r.status, 200);
r = await http('GET', `/api/stickers/packs/${packId}`, undefined, b.token);
assert.equal(r.status, 200, 'pack still exists after uninstall');
// telegram import without a token → 501
r = await http('POST', '/api/stickers/import-telegram', { name: 'HotCherry' }, b.token);
assert.equal(r.status, 501, JSON.stringify(r.data));
log('sticker install/uninstall/permissions + telegram-import gating OK');

// ---- typing relay over WS
const wsA = new WebSocket(`${BASE.replace('http', 'ws')}/ws`);
const wsB = new WebSocket(`${BASE.replace('http', 'ws')}/ws`);
wsA.on('open', () => wsA.send(JSON.stringify({ type: 'auth', token: a.token })));
wsB.on('open', () => wsB.send(JSON.stringify({ type: 'auth', token: b.token })));
const readyA = new Promise((res) => wsA.on('message', (d) => { if (JSON.parse(d.toString()).type === 'ready') res(); }));
const readyB = new Promise((res) => wsB.on('message', (d) => { if (JSON.parse(d.toString()).type === 'ready') res(); }));
const typingSeen = new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('typing timeout')), 8000);
  wsB.on('message', (d) => {
    const ev = JSON.parse(d.toString());
    if (ev.type === 'typing' && ev.convId === convId && ev.ref === a.ref) {
      clearTimeout(t); resolve();
    }
  });
});
await Promise.all([readyA, readyB]);
wsA.send(JSON.stringify({ type: 'typing', convId }));
await typingSeen;
wsA.close(); wsB.close();
log('typing indicator relayed a → b');

console.log('\nALL NEW-FEATURE TESTS PASSED 🎉');
process.exit(0);
