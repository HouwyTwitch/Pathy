// Telegram-style bot API. Everything content-related is still end-to-end
// encrypted: the SDK does the crypto with the bot's own keypair, and this
// API only relays ciphertext, envelopes and public bundles.
import { Router, raw } from 'express';
import { randomUUID } from 'node:crypto';
import { q, memberOf } from '../db.js';
import { REF_RE, isPublicBundle, isCipherMessage, HttpError, asyncRoute } from '../util.js';
import { requireBot } from '../auth.js';
import { rateLimit } from '../ratelimit.js';
import { bus, deliverToConversation } from '../events.js';

export const botapi = Router({ mergeParams: true });

botapi.use(requireBot);
botapi.use(rateLimit({ windowMs: 60_000, max: 1200, keyFn: (req) => `bot:${req.bot.id}` }));

botapi.get('/getMe', (req, res) => {
  res.json({ ref: req.bot.ref, username: req.bot.username, hasKeys: req.bot.hasBundle });
});

botapi.post('/setBundle', asyncRoute(async (req, res) => {
  const { pubBundle } = req.body || {};
  if (!isPublicBundle(pubBundle)) throw new HttpError(400, 'bad public bundle');
  // First write wins: bot keys are immutable so members who verified the
  // bot's fingerprint can't be silently re-keyed by a stolen token.
  const r = await q(
    'UPDATE bots SET pub_bundle = $1 WHERE id = $2 AND pub_bundle IS NULL RETURNING id',
    [pubBundle, req.bot.id],
  );
  if (r.rowCount === 0) throw new HttpError(409, 'bundle already set');
  res.json({ ok: true });
}));

botapi.get('/getUpdates', asyncRoute(async (req, res) => {
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const timeout = Math.min(Math.max(Number(req.query.timeout) || 0, 0), 30);
  if (offset > 0) {
    await q('DELETE FROM bot_updates WHERE bot_id = $1 AND id < $2', [req.bot.id, offset]);
  }
  const fetch = () => q(
    `SELECT id::int AS "updateId", type, payload, created_at AS ts
     FROM bot_updates WHERE bot_id = $1 AND id >= $2 ORDER BY id LIMIT 100`,
    [req.bot.id, offset],
  );
  let r = await fetch();
  if (r.rowCount === 0 && timeout > 0) {
    await new Promise((resolve) => {
      const done = () => { clearTimeout(t); bus.off(`bot:${req.bot.id}`, done); resolve(); };
      const t = setTimeout(done, timeout * 1000);
      bus.on(`bot:${req.bot.id}`, done);
      req.on('close', done);
    });
    if (res.writableEnded || req.destroyed) return;
    r = await fetch();
  }
  res.json({ updates: r.rows });
}));

botapi.get('/conversations', asyncRoute(async (req, res) => {
  const r = await q(
    `SELECT c.id, c.type, c.name, c.scope, c.key_version AS "keyVersion", m.role AS "myRole",
       (SELECT json_agg(json_build_object('ref', mm.ref, 'role', mm.role) ORDER BY mm.added_at)
          FROM members mm WHERE mm.conv_id = c.id) AS members
     FROM conversations c JOIN members m ON m.conv_id = c.id AND m.ref = $1
     ORDER BY c.id`,
    [req.bot.ref],
  );
  res.json({ conversations: r.rows });
}));

async function requireBotMembership(convId, ref) {
  if (!Number.isInteger(convId) || convId < 1) throw new HttpError(400, 'bad conversation id');
  const conv = await q('SELECT id, type, key_version FROM conversations WHERE id = $1', [convId]);
  if (!conv.rows[0]) throw new HttpError(404, 'conversation not found');
  const membership = await memberOf(convId, ref);
  if (!membership) throw new HttpError(403, 'bot is not a member');
  return { conv: conv.rows[0], role: membership.role };
}

botapi.get('/conversations/:id/envelopes', asyncRoute(async (req, res) => {
  const convId = Number(req.params.id);
  await requireBotMembership(convId, req.bot.ref);
  const r = await q(
    'SELECT key_version AS "keyVersion", payload FROM envelopes WHERE conv_id = $1 AND ref = $2 ORDER BY key_version',
    [convId, req.bot.ref],
  );
  res.json({ envelopes: r.rows });
}));

botapi.get('/conversations/:id/messages', asyncRoute(async (req, res) => {
  const convId = Number(req.params.id);
  await requireBotMembership(convId, req.bot.ref);
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
  const beforeId = Number(req.query.beforeId) || null;
  const r = await q(
    `SELECT id, sender_ref AS "senderRef", key_version AS "keyVersion", n, ct, sig, created_at AS ts
     FROM messages WHERE conv_id = $1 AND ($2::bigint IS NULL OR id < $2)
     ORDER BY id DESC LIMIT $3`,
    [convId, beforeId, limit],
  );
  res.json({ messages: r.rows.reverse() });
}));

botapi.get('/bundles/:ref', asyncRoute(async (req, res) => {
  const ref = req.params.ref;
  if (!REF_RE.test(ref)) throw new HttpError(400, 'bad ref');
  const name = ref.slice(2);
  const r = ref.startsWith('u:')
    ? await q('SELECT pub_bundle FROM users WHERE username = $1', [name])
    : await q('SELECT pub_bundle FROM bots WHERE username = $1', [name]);
  if (!r.rows[0]?.pub_bundle) throw new HttpError(404, 'not found');
  res.json({ ref, username: name, bundle: r.rows[0].pub_bundle });
}));

// Encrypted attachments — same contract as the user API: the server stores
// only ciphertext, the per-file key travels inside the E2E message body.
const MAX_BLOB_SIZE = 64 * 1024 * 1024 + 4096;
const BLOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

botapi.post(
  '/conversations/:id/blobs',
  rateLimit({ windowMs: 60_000, max: 30, keyFn: (req) => `bot:${req.bot.id}` }),
  raw({ type: 'application/octet-stream', limit: MAX_BLOB_SIZE }),
  asyncRoute(async (req, res) => {
    const convId = Number(req.params.id);
    const { conv, role } = await requireBotMembership(convId, req.bot.ref);
    if (conv.type === 'channel' && role !== 'admin') {
      throw new HttpError(403, 'only admin bots post in channels');
    }
    if (!Buffer.isBuffer(req.body) || req.body.length < 17) {
      throw new HttpError(400, 'expected an encrypted blob (application/octet-stream)');
    }
    const id = randomUUID();
    await q('INSERT INTO blobs (id, conv_id, uploader_ref, size, data) VALUES ($1, $2, $3, $4, $5)', [
      id, convId, req.bot.ref, req.body.length, req.body,
    ]);
    res.status(201).json({ blobId: id, size: req.body.length });
  }),
);

botapi.get('/blobs/:id', asyncRoute(async (req, res) => {
  const id = String(req.params.id || '');
  if (!BLOB_ID_RE.test(id)) throw new HttpError(400, 'bad blob id');
  const r = await q('SELECT conv_id, data FROM blobs WHERE id = $1', [id]);
  if (!r.rows[0]) throw new HttpError(404, 'blob not found');
  await requireBotMembership(r.rows[0].conv_id, req.bot.ref);
  res.set({
    'Content-Type': 'application/octet-stream',
    'Cache-Control': 'private, max-age=31536000, immutable',
  });
  res.send(r.rows[0].data);
}));

botapi.post('/sendMessage', asyncRoute(async (req, res) => {
  const { convId, ...m } = req.body || {};
  const { conv, role } = await requireBotMembership(Number(convId), req.bot.ref);
  if (conv.type === 'channel' && role !== 'admin') {
    throw new HttpError(403, 'only admin bots post in channels');
  }
  if (!isCipherMessage(m)) throw new HttpError(400, 'bad message');
  if (m.keyVersion !== conv.key_version) {
    throw new HttpError(409, `stale key version (current is ${conv.key_version})`);
  }
  const r = await q(
    `INSERT INTO messages (conv_id, sender_ref, key_version, n, ct, sig)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at AS ts`,
    [conv.id, req.bot.ref, m.keyVersion, m.n, m.ct, m.sig],
  );
  const message = {
    id: r.rows[0].id, convId: conv.id, senderRef: req.bot.ref, keyVersion: m.keyVersion,
    n: m.n, ct: m.ct, sig: m.sig, ts: r.rows[0].ts,
  };
  await deliverToConversation(conv.id, { type: 'message', convId: conv.id, convType: conv.type, message });
  res.status(201).json({ id: message.id, ts: message.ts });
}));
