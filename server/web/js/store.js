// Client-side state + all E2E crypto orchestration: identity keys, verified
// public-bundle cache, conversation key cache, encrypt/decrypt, envelope
// wrapping for invites and rotation.
//
// Secret material lives in memory and (as a reload convenience) in
// sessionStorage for the lifetime of the tab. It is never sent to the
// server; the server only holds a password-encrypted backup blob.
import * as C from '/shared/crypto.js';
import { api, setToken } from './api.js';

export const state = {
  me: null,          // { ref, username, settings }
  keys: null,        // identity keys (see crypto.keysFromSeeds)
  conversations: [], // conv summaries from the server
  bundles: new Map(),   // ref -> { username, kind, keys|null, bundle, online }
  convKeys: new Map(),  // convId -> Map(keyVersion -> Uint8Array)
};

// ------------------------------------------------------------ persistence

function saveSeeds() {
  sessionStorage.setItem('pathy.seeds', JSON.stringify({
    ref: state.me.ref,
    kem: C.toB64(state.keys.kemSeed),
    dsa: C.toB64(state.keys.dsaSeed),
  }));
}

export function tryRestoreSeeds(meRef) {
  try {
    const raw = sessionStorage.getItem('pathy.seeds');
    if (!raw) return false;
    const s = JSON.parse(raw);
    if (s.ref !== meRef) return false;
    state.keys = C.keysFromSeeds(C.fromB64(s.kem), C.fromB64(s.dsa));
    return true;
  } catch {
    return false;
  }
}

export function lock() {
  sessionStorage.removeItem('pathy.seeds');
  state.keys = null;
}

// ----------------------------------------------------------------- auth

export async function register(username, password) {
  const salt = C.newSalt();
  const { authKey, backupKey } = C.deriveLoginKeys(password, salt);
  const keys = C.generateIdentity();
  const ref = `u:${username}`;
  const res = await api.register({
    username, salt, authKey,
    pubBundle: C.makePublicBundle(keys, ref),
    backup: C.encryptBackup(backupKey, keys, username),
  });
  setToken(res.token);
  state.me = res.me;
  state.keys = keys;
  saveSeeds();
  return res.me;
}

export async function login(username, password) {
  const { salt } = await api.loginSalt(username);
  const { authKey, backupKey } = C.deriveLoginKeys(password, salt);
  const res = await api.login({ username, authKey });
  const keys = C.decryptBackup(backupKey, res.backup, username); // throws on wrong pw (can't happen: authKey gate)
  setToken(res.token);
  state.me = res.me;
  state.keys = keys;
  saveSeeds();
  return res.me;
}

// Unlock after reload: session token is still valid but seeds were not in
// sessionStorage (new tab) — one scrypt run to decrypt the backup again.
export async function unlock(password) {
  const me = await api.me();
  const { salt } = await api.loginSalt(me.username);
  const { authKey, backupKey } = C.deriveLoginKeys(password, salt);
  const res = await api.login({ username: me.username, authKey });
  setToken(res.token);
  state.me = res.me;
  state.keys = C.decryptBackup(backupKey, res.backup, me.username);
  saveSeeds();
  return res.me;
}

export async function logout() {
  try { await api.logout(); } catch { /* session may already be gone */ }
  setToken(null);
  lock();
  state.me = null;
  state.conversations = [];
  state.bundles.clear();
  state.convKeys.clear();
}

// -------------------------------------------------------------- bundles

// Fetch + signature-verify a principal's public bundle. Returns
// { username, kind, keys: {kem, dsa} | null, bundle, online } — keys is null
// if verification failed (UI marks such senders untrusted).
export async function getBundle(ref, { refresh = false } = {}) {
  if (!refresh && state.bundles.has(ref)) return state.bundles.get(ref);
  const res = await api.bundle(ref);
  const keys = C.verifyPublicBundle(res.bundle, ref);
  const entry = {
    username: res.username, kind: res.kind, keys, bundle: res.bundle,
    online: res.online, avatarRev: res.avatarRev || 0,
  };
  state.bundles.set(ref, entry);
  return entry;
}

export function fingerprintOf(ref) {
  const b = state.bundles.get(ref);
  return b ? C.fingerprint(b.bundle, ref) : null;
}

export const myFingerprint = () =>
  C.fingerprint(C.makePublicBundle(state.keys, state.me.ref), state.me.ref);

// ------------------------------------------------------- conversation keys

function cacheKey(convId, version, key) {
  if (!state.convKeys.has(convId)) state.convKeys.set(convId, new Map());
  state.convKeys.get(convId).set(version, key);
}

// Envelopes are cryptographically bound to conv.scope. For DMs the scope is
// recomputed locally from the member refs so a malicious server cannot remap
// an envelope from one DM to another.
export function verifiedScope(conv) {
  if (conv.type === 'dm') {
    const refs = (conv.members || []).map((m) => m.ref);
    if (refs.length !== 2) throw new Error('malformed dm');
    const expected = C.dmScope(refs[0], refs[1]);
    if (conv.scope !== expected) throw new Error('dm scope mismatch — refusing to use keys');
    return expected;
  }
  return conv.scope;
}

export async function loadConvKeys(conv) {
  const scope = verifiedScope(conv);
  const { envelopes } = await api.envelopes(conv.id);
  for (const { keyVersion, payload } of envelopes) {
    if (state.convKeys.get(conv.id)?.has(keyVersion)) continue;
    try {
      const signer = await getBundle(payload.from);
      if (!signer.keys) throw new Error(`cannot verify envelope signer ${payload.from}`);
      const key = C.unwrapKey(payload, scope, keyVersion, state.me.ref, state.keys, signer.keys.dsa);
      cacheKey(conv.id, keyVersion, key);
    } catch (err) {
      console.warn(`envelope v${keyVersion} for conv ${conv.id} rejected:`, err.message);
    }
  }
  return state.convKeys.get(conv.id) || new Map();
}

export async function getConvKey(conv, version) {
  let key = state.convKeys.get(conv.id)?.get(version);
  if (!key) {
    await loadConvKeys(conv);
    key = state.convKeys.get(conv.id)?.get(version);
  }
  return key || null;
}

// Accept an envelope pushed over WS (rotation, new conversation).
export async function acceptEnvelope(conv, keyVersion, payload) {
  try {
    const scope = verifiedScope(conv);
    const signer = await getBundle(payload.from);
    if (!signer.keys) return;
    const key = C.unwrapKey(payload, scope, keyVersion, state.me.ref, state.keys, signer.keys.dsa);
    cacheKey(conv.id, keyVersion, key);
  } catch (err) {
    console.warn('pushed envelope rejected:', err.message);
  }
}

// --------------------------------------------------------- send / receive

export async function decryptMessage(conv, msg) {
  const key = await getConvKey(conv, msg.keyVersion);
  if (!key) return { error: 'no key for this message' };
  let senderDsa = null;
  try {
    const sender = await getBundle(msg.senderRef);
    senderDsa = sender.keys?.dsa || null;
  } catch { /* sender may be deleted; decrypt but mark unverified */ }
  try {
    const { body, verified } = C.decryptMessage(key, conv.id, msg, senderDsa);
    return { body, verified };
  } catch {
    return { error: 'decryption failed (tampered or corrupted)' };
  }
}

async function sendBody(conv, body) {
  const doSend = async () => {
    const key = await getConvKey(conv, conv.keyVersion);
    if (!key) throw new Error('no conversation key');
    const m = C.encryptMessage(key, conv.id, conv.keyVersion, state.me.ref, state.keys, body);
    return api.sendMessage(conv.id, m);
  };
  try {
    return await doSend();
  } catch (err) {
    if (err.status === 409) { // key rotated under us — refresh and retry once
      const fresh = await api.conversation(conv.id);
      conv.keyVersion = fresh.conversation.keyVersion;
      await loadConvKeys(conv);
      return doSend();
    }
    throw err;
  }
}

export function sendText(conv, text, replyTo = null) {
  return sendBody(conv, { t: 'text', text, ...(replyTo ? { replyTo } : {}), ts: Date.now() });
}

// st is either a plain emoji string (legacy built-in stickers) or a pack
// sticker { sid, pack, emoji, w, h, mime }.
export function sendSticker(conv, st, replyTo = null) {
  const body = typeof st === 'string' ? { t: 'sticker', emoji: st } : { t: 'sticker', ...st };
  return sendBody(conv, { ...body, ...(replyTo ? { replyTo } : {}), ts: Date.now() });
}

// Re-encrypt the edited text under the current conversation key and replace
// the message ciphertext server-side (sender-only, enforced by the server).
export async function editText(conv, msgId, text) {
  const doSend = async () => {
    const key = await getConvKey(conv, conv.keyVersion);
    if (!key) throw new Error('no conversation key');
    const m = C.encryptMessage(key, conv.id, conv.keyVersion, state.me.ref, state.keys, {
      t: 'text', text, ts: Date.now(),
    });
    return api.editMessage(conv.id, msgId, m);
  };
  try {
    return await doSend();
  } catch (err) {
    if (err.status === 409) {
      const fresh = await api.conversation(conv.id);
      conv.keyVersion = fresh.conversation.keyVersion;
      await loadConvKeys(conv);
      return doSend();
    }
    throw err;
  }
}

// ----------------------------------------------------------- attachments

export const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

// Encrypt a File/Blob chunk by chunk with a one-off key, upload the
// ciphertext chunks in order, then send a message whose (E2E-encrypted)
// body carries the blob reference + key. Chunking keeps memory flat, so
// multi-gigabyte files work in the browser. `extra` merges additional
// metadata into the body (image dimensions, voice/round kind, replyTo, …).
export async function sendFile(conv, file, onProgress, extra = {}) {
  if (file.size > MAX_FILE_BYTES) throw new Error('file is too large (max 2 GB)');
  if (file.size === 0) throw new Error('cannot send an empty file');
  const blobKey = C.newBlobKey();
  const prefix = C.newBlobNoncePrefix();
  const cs = C.BLOB_CHUNK_BYTES;
  const total = Math.ceil(file.size / cs);
  const { blobId } = await api.initBlob(conv.id, file.size, cs);
  for (let i = 0; i < total; i++) {
    const slice = file.slice(i * cs, Math.min(file.size, (i + 1) * cs));
    const pt = new Uint8Array(await slice.arrayBuffer());
    const ct = C.encryptBlobChunk(blobKey, prefix, i, total, pt);
    await api.uploadChunk(blobId, i, ct, (p) => onProgress?.((i + p) / total));
    onProgress?.((i + 1) / total);
  }
  const body = {
    t: 'file',
    name: String(file.name || 'file').slice(0, 255),
    size: file.size,
    mime: String(file.type || 'application/octet-stream').slice(0, 127),
    blobId,
    k: C.toB64(blobKey),
    np: C.toB64(prefix),
    cs,
    ...extra,
    ts: Date.now(),
  };
  const sent = await sendBody(conv, body);
  return { ...sent, body };
}

// Download + decrypt an attachment referenced by a file message body.
// Returns a Blob (browsers spill big blobs to disk, so 2 GB files are OK).
// Throws if the server returned different bytes than the sender uploaded.
export async function fetchFile(body, onProgress) {
  if (!body.np) {
    // v1 (legacy): whole file sealed in one AEAD call
    const ct = await api.fetchBlob(body.blobId);
    try {
      return new Blob([C.decryptBlob(C.fromB64(body.k), body.n, ct)],
        { type: body.mime || 'application/octet-stream' });
    } catch {
      throw new Error('attachment failed integrity check (tampered or corrupted)');
    }
  }
  const key = C.fromB64(body.k);
  const prefix = C.fromB64(body.np);
  const cs = body.cs;
  const total = Math.ceil(body.size / cs);
  const res = await api.fetchBlobResponse(body.blobId);
  const reader = res.body.getReader();
  const parts = [];
  let buf = new Uint8Array(0);
  let idx = 0;
  const ctLenOf = (i) => (i === total - 1 ? body.size - (total - 1) * cs : cs) + 16;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) {
        const merged = new Uint8Array(buf.length + value.length);
        merged.set(buf, 0);
        merged.set(value, buf.length);
        buf = merged;
        while (idx < total && buf.length >= ctLenOf(idx)) {
          const ctLen = ctLenOf(idx);
          parts.push(C.decryptBlobChunk(key, prefix, idx, total, buf.subarray(0, ctLen)));
          buf = buf.slice(ctLen);
          idx++;
          onProgress?.(idx / total);
        }
      }
      if (done) break;
    }
  } catch {
    throw new Error('attachment failed integrity check (tampered or corrupted)');
  }
  if (idx !== total || buf.length !== 0) {
    throw new Error('attachment is incomplete (truncated download)');
  }
  return new Blob(parts, { type: body.mime || 'application/octet-stream' });
}

// -------------------------------------------------- create / invite / rotate

async function wrapTo(ref, scope, keyVersion, key) {
  const target = await getBundle(ref);
  if (!target.keys) throw new Error(`cannot verify keys of ${ref}`);
  return C.wrapKey(key, scope, keyVersion, ref, target.keys.kem, state.me.ref, state.keys);
}

export async function startDm(peerRef) {
  const key = C.newConversationKey();
  const peer = await getBundle(peerRef);
  if (!peer.keys) throw new Error(`cannot verify keys of ${peerRef}`);
  const scope = C.dmScope(state.me.ref, peerRef);
  const mine = [{ keyVersion: 1, payload: C.wrapKey(key, scope, 1, state.me.ref, state.keys.kemPublic, state.me.ref, state.keys) }];
  const theirs = [{ keyVersion: 1, payload: C.wrapKey(key, scope, 1, peerRef, peer.keys.kem, state.me.ref, state.keys) }];
  const res = await api.createConversation({
    type: 'dm', peerRef,
    envelopes: { [state.me.ref]: mine, [peerRef]: theirs },
  });
  const conv = res.conversation;
  if (!res.existing) cacheKey(conv.id, 1, key);
  return conv;
}

export async function createRoom(type, name) {
  const key = C.newConversationKey();
  const scope = `room:${crypto.randomUUID()}`;
  const mine = [{ keyVersion: 1, payload: C.wrapKey(key, scope, 1, state.me.ref, state.keys.kemPublic, state.me.ref, state.keys) }];
  const res = await api.createConversation({
    type, name, scope, envelopes: { [state.me.ref]: mine },
  });
  cacheKey(res.conversation.id, 1, key);
  return res.conversation;
}

export async function invite(conv, ref, role = 'member') {
  const scope = verifiedScope(conv);
  const keys = await loadConvKeys(conv);
  const envelopes = [];
  for (const [version, key] of [...keys.entries()].sort((a, b) => a[0] - b[0])) {
    envelopes.push({ keyVersion: version, payload: await wrapTo(ref, scope, version, key) });
  }
  if (envelopes.length === 0) throw new Error('no conversation keys to share');
  return api.addMember(conv.id, { ref, role, envelopes });
}

export async function rotateKey(conv) {
  const fresh = await api.conversation(conv.id);
  const current = fresh.conversation;
  const scope = verifiedScope(current);
  const nextVersion = current.keyVersion + 1;
  const key = C.newConversationKey();
  const envelopes = {};
  for (const m of current.members) {
    envelopes[m.ref] = await wrapTo(m.ref, scope, nextVersion, key);
  }
  await api.rotate(conv.id, { keyVersion: nextVersion, envelopes });
  cacheKey(conv.id, nextVersion, key);
  conv.keyVersion = nextVersion;
  return nextVersion;
}

export async function removeMemberAndRotate(conv, ref) {
  await api.removeMember(conv.id, ref);
  if (ref === state.me.ref) return; // left the room ourselves
  await rotateKey(conv); // removed member cannot read anything sent after this
}
