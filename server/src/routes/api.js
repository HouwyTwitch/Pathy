import { Router, raw } from 'express';
import { randomBytes, randomUUID } from 'node:crypto';
import { q, pool, areContacts, memberOf, memberRefs } from '../db.js';
import {
  sha256, b64uToBuf, newToken, safeEqual, decoySalt,
  USERNAME_RE, REF_RE, isB64u, isPublicBundle, isBackup, isEnvelope, isCipherMessage,
  HttpError, asyncRoute,
} from '../util.js';
import { requireSession } from '../auth.js';
import { rateLimit } from '../ratelimit.js';
import { deliver, deliverToConversation } from '../events.js';
import { isOnline } from '../ws.js';

export const api = Router();

const DEFAULT_SETTINGS = Object.freeze({
  whoCanDm: 'everyone',      // everyone | contacts | nobody
  whoCanAdd: 'everyone',     // everyone | contacts | nobody
  discoverable: true,        // appear in prefix search (exact match always works)
  showOnline: true,          // expose online/offline presence
});

const settingsOf = (raw) => ({ ...DEFAULT_SETTINGS, ...(raw || {}) });

function convSummary(c, myRole, members) {
  return {
    id: c.id,
    type: c.type,
    name: c.name,
    scope: c.scope,
    keyVersion: c.key_version,
    myRole,
    members,
  };
}

const ROOM_SCOPE_RE = /^room:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function loadMembers(convId) {
  const r = await q('SELECT ref, role FROM members WHERE conv_id = $1 ORDER BY added_at', [convId]);
  return r.rows;
}

// "contacts" policy gate shared by DM creation and member adds.
async function checkPolicy(setting, targetRef, actorRef, action) {
  if (setting === 'nobody') throw new HttpError(403, `${targetRef} does not allow this (${action})`);
  if (setting === 'contacts' && !(await areContacts(targetRef, actorRef))) {
    throw new HttpError(403, `${targetRef} only allows ${action} from people they already talk to`);
  }
}

// --------------------------------------------------------------- accounts

const authLimiter = rateLimit({ windowMs: 60_000, max: 10 });

api.post('/register', authLimiter, asyncRoute(async (req, res) => {
  const { username, salt, authKey, pubBundle, backup } = req.body || {};
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    throw new HttpError(400, 'username must match [a-z0-9_]{3,32}');
  }
  if (!isB64u(salt, 64) || !isB64u(authKey, 64)) throw new HttpError(400, 'bad salt/authKey');
  if (!isPublicBundle(pubBundle)) throw new HttpError(400, 'bad public bundle');
  if (!isBackup(backup)) throw new HttpError(400, 'bad key backup');

  const authHash = sha256(b64uToBuf(authKey));
  let user;
  try {
    const r = await q(
      `INSERT INTO users (username, salt, auth_hash, pub_bundle, backup, settings)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [username, salt, authHash, pubBundle, backup, DEFAULT_SETTINGS],
    );
    user = r.rows[0];
  } catch (err) {
    if (err.code === '23505') throw new HttpError(409, 'username taken');
    throw err;
  }
  const token = newToken();
  await q('INSERT INTO sessions (token_hash, user_id) VALUES ($1, $2)', [sha256(b64uToBuf(token)), user.id]);
  res.status(201).json({
    token,
    me: { ref: `u:${username}`, username, settings: DEFAULT_SETTINGS, avatarRev: 0 },
  });
}));

// Returns the scrypt salt for a username; a deterministic decoy for unknown
// names so this endpoint can't be used to enumerate accounts.
api.post('/login/salt', authLimiter, asyncRoute(async (req, res) => {
  const { username } = req.body || {};
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
    throw new HttpError(400, 'bad username');
  }
  const r = await q('SELECT salt FROM users WHERE username = $1', [username]);
  res.json({ salt: r.rows[0]?.salt ?? decoySalt(username) });
}));

api.post('/login', authLimiter, asyncRoute(async (req, res) => {
  const { username, authKey } = req.body || {};
  if (typeof username !== 'string' || !USERNAME_RE.test(username) || !isB64u(authKey, 64)) {
    throw new HttpError(400, 'bad credentials');
  }
  const r = await q(
    `SELECT id, username, auth_hash, backup, settings,
            CASE WHEN avatar IS NULL THEN 0 ELSE avatar_rev END AS avatar_rev
     FROM users WHERE username = $1`, [username],
  );
  const row = r.rows[0];
  const presented = sha256(b64uToBuf(authKey));
  if (!row || !safeEqual(presented, row.auth_hash)) throw new HttpError(401, 'invalid credentials');
  const token = newToken();
  await q('INSERT INTO sessions (token_hash, user_id) VALUES ($1, $2)', [sha256(b64uToBuf(token)), row.id]);
  res.json({
    token,
    backup: row.backup,
    me: {
      ref: `u:${row.username}`, username: row.username,
      settings: settingsOf(row.settings), avatarRev: row.avatar_rev || 0,
    },
  });
}));

api.use(requireSession);
api.use(rateLimit({ windowMs: 60_000, max: 600, keyFn: (req) => req.user.ref }));

api.post('/logout', asyncRoute(async (req, res) => {
  await q('DELETE FROM sessions WHERE id = $1', [req.user.sessionId]);
  res.json({ ok: true });
}));

api.get('/me', asyncRoute(async (req, res) => {
  const r = await q('SELECT CASE WHEN avatar IS NULL THEN 0 ELSE avatar_rev END AS rev FROM users WHERE id = $1', [req.user.id]);
  res.json({
    ref: req.user.ref,
    username: req.user.username,
    settings: settingsOf(req.user.settings),
    avatarRev: r.rows[0]?.rev || 0,
  });
}));

// ---------------------------------------------------------------- avatars

// Profile pictures are visible to any logged-in user (like usernames);
// they are not E2E content. Clients downscale before upload.
const AVATAR_MIMES = ['image/jpeg', 'image/png', 'image/webp'];

api.put(
  '/me/avatar',
  rateLimit({ windowMs: 60_000, max: 10, keyFn: (req) => req.user.ref }),
  raw({ type: 'image/*', limit: 300 * 1024 }),
  asyncRoute(async (req, res) => {
    const mime = String(req.headers['content-type'] || '').split(';')[0].trim();
    if (!AVATAR_MIMES.includes(mime)) throw new HttpError(400, 'avatar must be jpeg, png or webp');
    if (!Buffer.isBuffer(req.body) || req.body.length < 100) throw new HttpError(400, 'empty image');
    const r = await q(
      'UPDATE users SET avatar = $1, avatar_mime = $2, avatar_rev = avatar_rev + 1 WHERE id = $3 RETURNING avatar_rev',
      [req.body, mime, req.user.id],
    );
    res.json({ ok: true, avatarRev: r.rows[0].avatar_rev });
  }),
);

api.delete('/me/avatar', asyncRoute(async (req, res) => {
  await q(
    'UPDATE users SET avatar = NULL, avatar_mime = NULL, avatar_rev = avatar_rev + 1 WHERE id = $1',
    [req.user.id],
  );
  res.json({ ok: true, avatarRev: 0 });
}));

api.get('/avatars/:ref', asyncRoute(async (req, res) => {
  const ref = req.params.ref;
  if (!REF_RE.test(ref) || !ref.startsWith('u:')) throw new HttpError(404, 'no avatar');
  const r = await q('SELECT avatar, avatar_mime FROM users WHERE username = $1', [ref.slice(2)]);
  if (!r.rows[0]?.avatar) throw new HttpError(404, 'no avatar');
  res.set({
    'Content-Type': r.rows[0].avatar_mime || 'image/jpeg',
    'Cache-Control': 'private, max-age=31536000, immutable', // URL carries ?v=<rev>
  });
  res.send(r.rows[0].avatar);
}));

api.put('/me/settings', asyncRoute(async (req, res) => {
  const body = req.body || {};
  const next = settingsOf(req.user.settings);
  const enums = ['everyone', 'contacts', 'nobody'];
  if (body.whoCanDm !== undefined) {
    if (!enums.includes(body.whoCanDm)) throw new HttpError(400, 'bad whoCanDm');
    next.whoCanDm = body.whoCanDm;
  }
  if (body.whoCanAdd !== undefined) {
    if (!enums.includes(body.whoCanAdd)) throw new HttpError(400, 'bad whoCanAdd');
    next.whoCanAdd = body.whoCanAdd;
  }
  if (body.discoverable !== undefined) {
    if (typeof body.discoverable !== 'boolean') throw new HttpError(400, 'bad discoverable');
    next.discoverable = body.discoverable;
  }
  if (body.showOnline !== undefined) {
    if (typeof body.showOnline !== 'boolean') throw new HttpError(400, 'bad showOnline');
    next.showOnline = body.showOnline;
  }
  await q('UPDATE users SET settings = $1 WHERE id = $2', [next, req.user.id]);
  res.json({ settings: next });
}));

// ---------------------------------------------------------------- people

api.get('/users/search', asyncRoute(async (req, res) => {
  const qs = String(req.query.q || '').toLowerCase().trim();
  if (qs.length < 2 || qs.length > 32 || !/^[a-z0-9_]+$/.test(qs)) return res.json({ results: [] });
  const prefix = qs.replaceAll('\\', '\\\\').replaceAll('_', '\\_').replaceAll('%', '\\%') + '%';
  const users = await q(
    `SELECT username, CASE WHEN avatar IS NULL THEN 0 ELSE avatar_rev END AS avatar_rev FROM users
     WHERE (username LIKE $1 ESCAPE '\\' AND COALESCE((settings->>'discoverable')::boolean, true))
        OR username = $2
     ORDER BY username LIMIT 10`,
    [prefix, qs],
  );
  const bots = await q(
    `SELECT username FROM bots WHERE pub_bundle IS NOT NULL AND (username LIKE $1 ESCAPE '\\' OR username = $2)
     ORDER BY username LIMIT 10`,
    [prefix, qs],
  );
  const results = [
    ...users.rows.filter((u) => u.username !== req.user.username)
      .map((u) => ({ ref: `u:${u.username}`, username: u.username, kind: 'user', avatarRev: u.avatar_rev || 0 })),
    ...bots.rows.map((b) => ({ ref: `b:${b.username}`, username: b.username, kind: 'bot', avatarRev: 0 })),
  ].slice(0, 10);
  res.json({ results });
}));

api.get('/bundles/:ref', asyncRoute(async (req, res) => {
  const ref = req.params.ref;
  if (!REF_RE.test(ref)) throw new HttpError(400, 'bad ref');
  const name = ref.slice(2);
  if (ref.startsWith('u:')) {
    const r = await q(
      `SELECT pub_bundle, settings, CASE WHEN avatar IS NULL THEN 0 ELSE avatar_rev END AS avatar_rev
       FROM users WHERE username = $1`, [name],
    );
    if (!r.rows[0]) throw new HttpError(404, 'not found');
    const s = settingsOf(r.rows[0].settings);
    return res.json({
      ref, username: name, kind: 'user',
      bundle: r.rows[0].pub_bundle,
      online: s.showOnline ? isOnline(ref) : null,
      avatarRev: r.rows[0].avatar_rev || 0,
    });
  }
  const r = await q('SELECT pub_bundle FROM bots WHERE username = $1', [name]);
  if (!r.rows[0] || !r.rows[0].pub_bundle) throw new HttpError(404, 'not found');
  res.json({ ref, username: name, kind: 'bot', bundle: r.rows[0].pub_bundle, online: null });
}));

// ---------------------------------------------------------- conversations

async function assertRefExists(ref) {
  const name = ref.slice(2);
  if (ref.startsWith('u:')) {
    const r = await q('SELECT id, settings FROM users WHERE username = $1', [name]);
    if (!r.rows[0]) throw new HttpError(404, `${ref} not found`);
    return { kind: 'user', settings: settingsOf(r.rows[0].settings) };
  }
  const r = await q('SELECT id, pub_bundle FROM bots WHERE username = $1', [name]);
  if (!r.rows[0]) throw new HttpError(404, `${ref} not found`);
  if (!r.rows[0].pub_bundle) throw new HttpError(409, `${ref} has not published keys yet`);
  return { kind: 'bot', settings: null };
}

function validEnvelopeList(list, maxVersion, fromRef) {
  if (!Array.isArray(list) || list.length === 0 || list.length > 64) return false;
  const seen = new Set();
  for (const e of list) {
    if (!e || !Number.isInteger(e.keyVersion) || e.keyVersion < 1 || e.keyVersion > maxVersion) return false;
    if (seen.has(e.keyVersion)) return false;
    seen.add(e.keyVersion);
    if (!isEnvelope(e.payload) || e.payload.from !== fromRef) return false;
  }
  return true;
}

async function insertEnvelopes(client, convId, ref, list, fromRef) {
  for (const e of list) {
    await client.query(
      `INSERT INTO envelopes (conv_id, ref, key_version, payload, created_by_ref)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (conv_id, ref, key_version) DO NOTHING`,
      [convId, ref, e.keyVersion, e.payload, fromRef],
    );
  }
}

api.post('/conversations', asyncRoute(async (req, res) => {
  const { type, name, peerRef, envelopes } = req.body || {};
  const me = req.user.ref;

  if (type === 'dm') {
    if (typeof peerRef !== 'string' || !REF_RE.test(peerRef) || peerRef === me) {
      throw new HttpError(400, 'bad peerRef');
    }
    const peer = await assertRefExists(peerRef);
    if (peer.kind === 'user') {
      await checkPolicy(peer.settings.whoCanDm, peerRef, me, 'direct messages');
    }
    const scope = `dm:${[me, peerRef].sort().join('|')}`;
    const existing = await q('SELECT id, type, name, scope, key_version FROM conversations WHERE scope = $1', [scope]);
    if (existing.rows[0]) {
      const c = existing.rows[0];
      return res.json({ conversation: convSummary(c, 'member', await loadMembers(c.id)), existing: true });
    }
    const mine = envelopes?.[me];
    const theirs = envelopes?.[peerRef];
    if (!validEnvelopeList(mine, 1, me) || !validEnvelopeList(theirs, 1, me)) {
      throw new HttpError(400, 'dm requires key envelopes for both participants');
    }
    const client = await pool.connect();
    let conv;
    try {
      await client.query('BEGIN');
      const r = await client.query(
        `INSERT INTO conversations (type, scope, created_by_ref) VALUES ('dm', $1, $2)
         RETURNING id, type, name, scope, key_version`,
        [scope, me],
      );
      conv = r.rows[0];
      await client.query('INSERT INTO members (conv_id, ref, role) VALUES ($1, $2, $3), ($1, $4, $5)', [
        conv.id, me, 'member', peerRef, 'member',
      ]);
      await insertEnvelopes(client, conv.id, me, mine, me);
      await insertEnvelopes(client, conv.id, peerRef, theirs, me);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.code === '23505') throw new HttpError(409, 'dm already exists');
      throw err;
    } finally {
      client.release();
    }
    const members = await loadMembers(conv.id);
    await deliver([peerRef], {
      type: 'conv',
      conversation: convSummary(conv, 'member', members),
      envelopes: theirs,
    });
    return res.status(201).json({ conversation: convSummary(conv, 'member', members) });
  }

  if (type === 'group' || type === 'channel') {
    if (typeof name !== 'string' || name.trim().length < 1 || name.length > 64) {
      throw new HttpError(400, 'name required (1-64 chars)');
    }
    const scope = req.body.scope;
    if (typeof scope !== 'string' || !ROOM_SCOPE_RE.test(scope)) throw new HttpError(400, 'bad scope');
    const mine = envelopes?.[me];
    if (!validEnvelopeList(mine, 1, me)) throw new HttpError(400, 'missing creator envelope');
    const client = await pool.connect();
    let conv;
    try {
      await client.query('BEGIN');
      const r = await client.query(
        `INSERT INTO conversations (type, name, scope, created_by_ref) VALUES ($1, $2, $3, $4)
         RETURNING id, type, name, scope, key_version`,
        [type, name.trim(), scope, me],
      );
      conv = r.rows[0];
      await client.query("INSERT INTO members (conv_id, ref, role) VALUES ($1, $2, 'admin')", [conv.id, me]);
      await insertEnvelopes(client, conv.id, me, mine, me);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.code === '23505') throw new HttpError(409, 'scope conflict, retry');
      throw err;
    } finally {
      client.release();
    }
    return res.status(201).json({
      conversation: convSummary(conv, 'admin', [{ ref: me, role: 'admin' }]),
    });
  }

  throw new HttpError(400, 'type must be dm, group or channel');
}));

api.get('/conversations', asyncRoute(async (req, res) => {
  const r = await q(
    `SELECT c.id, c.type, c.name, c.scope, c.key_version, m.role AS my_role, m.pin_order,
       (SELECT json_agg(json_build_object('ref', mm.ref, 'role', mm.role,
          'avatarRev', COALESCE((SELECT CASE WHEN u.avatar IS NULL THEN 0 ELSE u.avatar_rev END
                                 FROM users u WHERE 'u:' || u.username = mm.ref), 0))
          ORDER BY mm.added_at)
          FROM members mm WHERE mm.conv_id = c.id) AS members,
       (SELECT row_to_json(t) FROM (
          SELECT id, sender_ref AS "senderRef", key_version AS "keyVersion", n, ct, sig,
                 created_at AS ts, edited_at AS "editedAt"
          FROM messages WHERE conv_id = c.id AND deleted_at IS NULL ORDER BY id DESC LIMIT 1) t) AS last_message,
       (SELECT COALESCE(json_object_agg(rr.ref, rr.last_read_id), '{}'::json)
          FROM reads rr WHERE rr.conv_id = c.id) AS reads
     FROM conversations c
     JOIN members m ON m.conv_id = c.id AND m.ref = $1
     ORDER BY (m.pin_order IS NULL), m.pin_order,
       (SELECT COALESCE(max(id), 0) FROM messages WHERE conv_id = c.id AND deleted_at IS NULL) DESC, c.id DESC`,
    [req.user.ref],
  );
  const conversations = r.rows.map((c) => ({
    ...convSummary(c, c.my_role, c.members || []),
    lastMessage: c.last_message,
    reads: c.reads || {},
    pinOrder: c.pin_order,
  }));
  res.json({ conversations });
}));

async function requireMembership(convId, ref) {
  if (!Number.isInteger(convId) || convId < 1) throw new HttpError(400, 'bad conversation id');
  const conv = await q('SELECT id, type, name, scope, key_version FROM conversations WHERE id = $1', [convId]);
  if (!conv.rows[0]) throw new HttpError(404, 'conversation not found');
  const membership = await memberOf(convId, ref);
  if (!membership) throw new HttpError(403, 'not a member');
  return { conv: conv.rows[0], role: membership.role };
}

api.get('/conversations/:id', asyncRoute(async (req, res) => {
  const convId = Number(req.params.id);
  const { conv, role } = await requireMembership(convId, req.user.ref);
  res.json({ conversation: convSummary(conv, role, await loadMembers(convId)) });
}));

api.get('/conversations/:id/envelopes', asyncRoute(async (req, res) => {
  const convId = Number(req.params.id);
  await requireMembership(convId, req.user.ref);
  const r = await q(
    'SELECT key_version, payload FROM envelopes WHERE conv_id = $1 AND ref = $2 ORDER BY key_version',
    [convId, req.user.ref],
  );
  res.json({ envelopes: r.rows.map((x) => ({ keyVersion: x.key_version, payload: x.payload })) });
}));

api.post('/conversations/:id/members', asyncRoute(async (req, res) => {
  const convId = Number(req.params.id);
  const me = req.user.ref;
  const { conv, role } = await requireMembership(convId, me);
  const { ref, role: newRole = 'member', envelopes } = req.body || {};

  if (conv.type === 'dm') throw new HttpError(400, 'cannot add members to a dm');
  if (typeof ref !== 'string' || !REF_RE.test(ref)) throw new HttpError(400, 'bad ref');
  if (!['member', 'admin'].includes(newRole)) throw new HttpError(400, 'bad role');
  if (conv.type === 'channel' && role !== 'admin') throw new HttpError(403, 'only admins add members to channels');
  if (newRole === 'admin' && role !== 'admin') throw new HttpError(403, 'only admins can grant admin');
  if (await memberOf(convId, ref)) throw new HttpError(409, 'already a member');

  const target = await assertRefExists(ref);
  if (target.kind === 'user') {
    await checkPolicy(target.settings.whoCanAdd, ref, me, 'group/channel invites');
  }
  if (!validEnvelopeList(envelopes, conv.key_version, me)) {
    throw new HttpError(400, 'bad envelopes');
  }
  if (!envelopes.some((e) => e.keyVersion === conv.key_version)) {
    throw new HttpError(400, `must include an envelope for current key version ${conv.key_version}`);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO members (conv_id, ref, role) VALUES ($1, $2, $3)', [convId, ref, newRole]);
    await insertEnvelopes(client, convId, ref, envelopes, me);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') throw new HttpError(409, 'already a member');
    throw err;
  } finally {
    client.release();
  }

  const members = await loadMembers(convId);
  await deliver([ref], {
    type: 'conv',
    conversation: convSummary(conv, newRole, members),
    envelopes,
  });
  await deliverToConversation(convId, {
    type: 'member', action: 'add', convId, ref, role: newRole, by: me,
  }, { skipBotUpdate: false });
  res.status(201).json({ ok: true, members });
}));

api.delete('/conversations/:id/members/:ref', asyncRoute(async (req, res) => {
  const convId = Number(req.params.id);
  const me = req.user.ref;
  const target = req.params.ref;
  const { conv, role } = await requireMembership(convId, me);
  if (!REF_RE.test(target)) throw new HttpError(400, 'bad ref');
  if (conv.type === 'dm') throw new HttpError(400, 'cannot leave a dm');
  if (target !== me && role !== 'admin') throw new HttpError(403, 'only admins remove members');
  if (!(await memberOf(convId, target))) throw new HttpError(404, 'not a member');

  // Notify while they are still a member (so bots get the update), then drop
  // their envelopes: removed members cannot fetch keys again. Reading future
  // messages is prevented by key rotation, which the admin client performs
  // right after removal.
  await deliverToConversation(convId, {
    type: 'member', action: 'remove', convId, ref: target, by: me,
  });
  await q('DELETE FROM members WHERE conv_id = $1 AND ref = $2', [convId, target]);
  await q('DELETE FROM envelopes WHERE conv_id = $1 AND ref = $2', [convId, target]);
  res.json({ ok: true });
}));

api.post('/conversations/:id/rotate', asyncRoute(async (req, res) => {
  const convId = Number(req.params.id);
  const me = req.user.ref;
  const { conv, role } = await requireMembership(convId, me);
  if (conv.type === 'dm') throw new HttpError(400, 'dm keys are not rotated');
  if (role !== 'admin') throw new HttpError(403, 'only admins rotate keys');

  const { keyVersion, envelopes } = req.body || {};
  if (keyVersion !== conv.key_version + 1) {
    throw new HttpError(409, `next key version must be ${conv.key_version + 1}`);
  }
  const current = new Set(await memberRefs(convId));
  if (!envelopes || typeof envelopes !== 'object' || Array.isArray(envelopes)) {
    throw new HttpError(400, 'envelopes must map ref -> envelope');
  }
  const refs = Object.keys(envelopes);
  if (refs.length !== current.size || !refs.every((r2) => current.has(r2))) {
    throw new HttpError(400, 'envelopes must cover exactly the current member set');
  }
  for (const r2 of refs) {
    if (!isEnvelope(envelopes[r2]) || envelopes[r2].from !== me) throw new HttpError(400, `bad envelope for ${r2}`);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const upd = await client.query(
      'UPDATE conversations SET key_version = $1 WHERE id = $2 AND key_version = $3 RETURNING id',
      [keyVersion, convId, conv.key_version],
    );
    if (upd.rowCount === 0) throw new HttpError(409, 'concurrent rotation, retry');
    for (const r2 of refs) {
      await client.query(
        `INSERT INTO envelopes (conv_id, ref, key_version, payload, created_by_ref)
         VALUES ($1, $2, $3, $4, $5)`,
        [convId, r2, keyVersion, envelopes[r2], me],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  for (const r2 of refs) {
    await deliver([r2], {
      type: 'envelope', convId, keyVersion,
      envelopes: [{ keyVersion, payload: envelopes[r2] }],
    });
  }
  res.json({ ok: true, keyVersion });
}));

api.get('/conversations/:id/messages', asyncRoute(async (req, res) => {
  const convId = Number(req.params.id);
  await requireMembership(convId, req.user.ref);
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
  const beforeId = Number(req.query.beforeId) || null;
  const r = await q(
    `SELECT id, sender_ref AS "senderRef", key_version AS "keyVersion", n, ct, sig, created_at AS ts,
            edited_at AS "editedAt"
     FROM messages WHERE conv_id = $1 AND deleted_at IS NULL AND ($2::bigint IS NULL OR id < $2)
     ORDER BY id DESC LIMIT $3`,
    [convId, beforeId, limit],
  );
  res.json({ messages: r.rows.reverse() });
}));

const messageLimiter = rateLimit({ windowMs: 60_000, max: 120, keyFn: (req) => req.user.ref });

api.post('/conversations/:id/messages', messageLimiter, asyncRoute(async (req, res) => {
  const convId = Number(req.params.id);
  const me = req.user.ref;
  const { conv, role } = await requireMembership(convId, me);
  if (conv.type === 'channel' && role !== 'admin') {
    throw new HttpError(403, 'only admins post in channels');
  }
  const m = req.body || {};
  if (!isCipherMessage(m)) throw new HttpError(400, 'bad message');
  if (m.keyVersion !== conv.key_version) {
    throw new HttpError(409, `stale key version (current is ${conv.key_version})`);
  }
  const r = await q(
    `INSERT INTO messages (conv_id, sender_ref, key_version, n, ct, sig)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at AS ts`,
    [convId, me, m.keyVersion, m.n, m.ct, m.sig],
  );
  const message = {
    id: r.rows[0].id, convId, senderRef: me, keyVersion: m.keyVersion,
    n: m.n, ct: m.ct, sig: m.sig, ts: r.rows[0].ts,
  };
  await deliverToConversation(convId, { type: 'message', convId, convType: conv.type, message });
  res.status(201).json({ id: message.id, ts: message.ts });
}));

// Edit: the sender re-encrypts the body under the current key and replaces
// the ciphertext. The server never sees either version's plaintext.
api.put('/conversations/:id/messages/:mid', messageLimiter, asyncRoute(async (req, res) => {
  const convId = Number(req.params.id);
  const mid = Number(req.params.mid);
  const me = req.user.ref;
  const { conv } = await requireMembership(convId, me);
  if (!Number.isInteger(mid) || mid < 1) throw new HttpError(400, 'bad message id');
  const m = req.body || {};
  if (!isCipherMessage(m)) throw new HttpError(400, 'bad message');
  if (m.keyVersion !== conv.key_version) {
    throw new HttpError(409, `stale key version (current is ${conv.key_version})`);
  }
  const r = await q(
    `UPDATE messages SET key_version = $1, n = $2, ct = $3, sig = $4, edited_at = now()
     WHERE id = $5 AND conv_id = $6 AND sender_ref = $7 AND deleted_at IS NULL
     RETURNING created_at AS ts, edited_at AS "editedAt"`,
    [m.keyVersion, m.n, m.ct, m.sig, mid, convId, me],
  );
  if (r.rowCount === 0) throw new HttpError(404, 'message not found or not yours');
  const message = {
    id: String(mid), convId, senderRef: me, keyVersion: m.keyVersion,
    n: m.n, ct: m.ct, sig: m.sig, ts: r.rows[0].ts, editedAt: r.rows[0].editedAt,
  };
  await deliverToConversation(convId, { type: 'message_edit', convId, message });
  res.json({ id: message.id, editedAt: message.editedAt });
}));

// Delete: the ciphertext is destroyed server-side, not just flagged.
api.delete('/conversations/:id/messages/:mid', asyncRoute(async (req, res) => {
  const convId = Number(req.params.id);
  const mid = Number(req.params.mid);
  const me = req.user.ref;
  const { conv, role } = await requireMembership(convId, me);
  if (!Number.isInteger(mid) || mid < 1) throw new HttpError(400, 'bad message id');
  const row = await q(
    'SELECT sender_ref FROM messages WHERE id = $1 AND conv_id = $2 AND deleted_at IS NULL',
    [mid, convId],
  );
  if (!row.rows[0]) throw new HttpError(404, 'message not found');
  const canDelete = row.rows[0].sender_ref === me || (role === 'admin' && conv.type !== 'dm');
  if (!canDelete) throw new HttpError(403, 'you can only delete your own messages');
  await q(
    "UPDATE messages SET n = '', ct = '', sig = '', deleted_at = now() WHERE id = $1",
    [mid],
  );
  await deliverToConversation(convId, { type: 'message_delete', convId, messageId: String(mid), by: me });
  res.json({ ok: true });
}));

// Read cursor (for sent → read double ticks). Not persisted to bots.
api.post('/conversations/:id/read', asyncRoute(async (req, res) => {
  const convId = Number(req.params.id);
  const me = req.user.ref;
  await requireMembership(convId, me);
  const wanted = Number(req.body?.lastReadId);
  if (!Number.isInteger(wanted) || wanted < 1) throw new HttpError(400, 'bad lastReadId');
  const mx = await q(
    'SELECT COALESCE(max(id), 0) AS mx FROM messages WHERE conv_id = $1 AND deleted_at IS NULL',
    [convId],
  );
  const target = Math.min(wanted, Number(mx.rows[0].mx));
  if (target < 1) return res.json({ ok: true, lastReadId: 0 });
  const r = await q(
    `INSERT INTO reads (conv_id, ref, last_read_id, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (conv_id, ref) DO UPDATE
       SET last_read_id = GREATEST(reads.last_read_id, EXCLUDED.last_read_id), updated_at = now()
     RETURNING last_read_id AS "lastReadId"`,
    [convId, me, target],
  );
  await deliverToConversation(convId, {
    type: 'read', convId, ref: me, lastReadId: Number(r.rows[0].lastReadId),
  }, { skipBotUpdate: true });
  res.json({ ok: true, lastReadId: Number(r.rows[0].lastReadId) });
}));

// Delete a whole conversation: any DM participant ("delete for both", like
// Telegram), or a room admin. Cascades messages, envelopes, blobs, reads.
api.delete('/conversations/:id', asyncRoute(async (req, res) => {
  const convId = Number(req.params.id);
  const me = req.user.ref;
  const { conv, role } = await requireMembership(convId, me);
  if (conv.type !== 'dm' && role !== 'admin') {
    throw new HttpError(403, 'only admins can delete a group or channel — leave it instead');
  }
  await deliverToConversation(convId, { type: 'conv_deleted', convId, by: me });
  await q('DELETE FROM conversations WHERE id = $1', [convId]);
  res.json({ ok: true });
}));

// Pinned chats: the client sends the full ordered list (top first).
api.put('/me/pins', asyncRoute(async (req, res) => {
  const order = req.body?.order;
  if (!Array.isArray(order) || order.length > 100
    || !order.every((x) => Number.isInteger(x) && x > 0)
    || new Set(order).size !== order.length) {
    throw new HttpError(400, 'order must be a unique list of conversation ids');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE members SET pin_order = NULL WHERE ref = $1', [req.user.ref]);
    for (let i = 0; i < order.length; i++) {
      await client.query(
        'UPDATE members SET pin_order = $1 WHERE conv_id = $2 AND ref = $3',
        [i, order[i], req.user.ref],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  res.json({ ok: true });
}));

// ------------------------------------------------------------------ blobs

// Encrypted attachments. Clients encrypt files with a random per-file key
// before upload; the key travels only inside the E2E-encrypted message that
// references the blob, so the server stores pure ciphertext.
const MAX_BLOB_SIZE = 64 * 1024 * 1024 + 4096; // 64 MB plaintext + AEAD overhead
const BLOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const blobLimiter = rateLimit({ windowMs: 60_000, max: 30, keyFn: (req) => req.user.ref });

api.post(
  '/conversations/:id/blobs',
  blobLimiter,
  raw({ type: 'application/octet-stream', limit: MAX_BLOB_SIZE }),
  asyncRoute(async (req, res) => {
    const convId = Number(req.params.id);
    const { conv, role } = await requireMembership(convId, req.user.ref);
    if (conv.type === 'channel' && role !== 'admin') {
      throw new HttpError(403, 'only admins post in channels');
    }
    if (!Buffer.isBuffer(req.body) || req.body.length < 17) {
      throw new HttpError(400, 'expected an encrypted blob (application/octet-stream)');
    }
    const id = randomUUID();
    await q('INSERT INTO blobs (id, conv_id, uploader_ref, size, data) VALUES ($1, $2, $3, $4, $5)', [
      id, convId, req.user.ref, req.body.length, req.body,
    ]);
    res.status(201).json({ blobId: id, size: req.body.length });
  }),
);

api.get('/blobs/:id', asyncRoute(async (req, res) => {
  const id = String(req.params.id || '');
  if (!BLOB_ID_RE.test(id)) throw new HttpError(400, 'bad blob id');
  const r = await q('SELECT conv_id, data FROM blobs WHERE id = $1', [id]);
  if (!r.rows[0]) throw new HttpError(404, 'blob not found');
  await requireMembership(r.rows[0].conv_id, req.user.ref);
  res.set({
    'Content-Type': 'application/octet-stream',
    'Cache-Control': 'private, max-age=31536000, immutable',
  });
  res.send(r.rows[0].data);
}));

// ------------------------------------------------------------------- bots

api.post('/bots', asyncRoute(async (req, res) => {
  const { username } = req.body || {};
  if (typeof username !== 'string' || !USERNAME_RE.test(username) || !username.endsWith('bot')) {
    throw new HttpError(400, "bot username must match [a-z0-9_]{3,32} and end with 'bot'");
  }
  const secret = randomBytes(32).toString('base64url');
  let bot;
  try {
    const r = await q(
      'INSERT INTO bots (username, owner_id, token_hash) VALUES ($1, $2, $3) RETURNING id',
      [username, req.user.id, sha256(b64uToBuf(secret))],
    );
    bot = r.rows[0];
  } catch (err) {
    if (err.code === '23505') throw new HttpError(409, 'bot username taken');
    throw err;
  }
  res.status(201).json({
    ref: `b:${username}`,
    username,
    token: `${bot.id}:${secret}`,
    note: 'store this token now — it is not shown again',
  });
}));

api.get('/bots', asyncRoute(async (req, res) => {
  const r = await q(
    'SELECT username, pub_bundle IS NOT NULL AS "hasKeys", created_at FROM bots WHERE owner_id = $1 ORDER BY id',
    [req.user.id],
  );
  res.json({ bots: r.rows.map((b) => ({ ref: `b:${b.username}`, ...b })) });
}));

api.delete('/bots/:username', asyncRoute(async (req, res) => {
  const r = await q('DELETE FROM bots WHERE username = $1 AND owner_id = $2 RETURNING id', [
    String(req.params.username || ''), req.user.id,
  ]);
  if (r.rowCount === 0) throw new HttpError(404, 'bot not found');
  res.json({ ok: true });
}));
