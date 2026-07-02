import { q } from './db.js';
import { sha256, b64uToBuf, HttpError, asyncRoute } from './util.js';

const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

// Shared by the REST middleware and the WebSocket handshake.
export async function sessionFromToken(token) {
  if (!token || typeof token !== 'string' || token.length > 256) return null;
  const r = await q(
    `SELECT s.id AS session_id, s.last_used, u.id, u.username, u.settings
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1`,
    [sha256(b64uToBuf(token))],
  );
  const row = r.rows[0];
  if (!row || Date.now() - new Date(row.last_used).getTime() > SESSION_TTL_MS) return null;
  return {
    id: row.id,
    username: row.username,
    ref: `u:${row.username}`,
    settings: row.settings,
    sessionId: row.session_id,
  };
}

// Bearer session auth for the user API. Sets req.user = { id, username, ref,
// settings } on success.
export const requireSession = asyncRoute(async (req, res, next) => {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token || token.length > 256) throw new HttpError(401, 'missing bearer token');
  const tokenHash = sha256(b64uToBuf(token));
  const r = await q(
    `SELECT s.id AS session_id, s.last_used, u.id, u.username, u.settings
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1`,
    [tokenHash],
  );
  const row = r.rows[0];
  if (!row) throw new HttpError(401, 'invalid session');
  if (Date.now() - new Date(row.last_used).getTime() > SESSION_TTL_MS) {
    await q('DELETE FROM sessions WHERE id = $1', [row.session_id]);
    throw new HttpError(401, 'session expired');
  }
  // Refresh the sliding expiry at most once a minute to avoid write churn.
  if (Date.now() - new Date(row.last_used).getTime() > 60_000) {
    q('UPDATE sessions SET last_used = now() WHERE id = $1', [row.session_id]).catch(() => {});
  }
  req.user = {
    id: row.id,
    username: row.username,
    ref: `u:${row.username}`,
    settings: row.settings,
    sessionId: row.session_id,
  };
  next();
});

// Token auth for the bot API. Tokens look like "<botId>:<secret>" — the id
// prefix lets us look the row up directly and compare hashes.
export const requireBot = asyncRoute(async (req, res, next) => {
  const token = req.params.token || '';
  const m = /^(\d{1,10}):([A-Za-z0-9_-]{20,128})$/.exec(token);
  if (!m) throw new HttpError(401, 'invalid bot token');
  const r = await q('SELECT id, username, owner_id, pub_bundle FROM bots WHERE id = $1 AND token_hash = $2', [
    Number(m[1]), sha256(b64uToBuf(m[2])),
  ]);
  const bot = r.rows[0];
  if (!bot) throw new HttpError(401, 'invalid bot token');
  req.bot = { id: bot.id, username: bot.username, ref: `b:${bot.username}`, hasBundle: !!bot.pub_bundle };
  next();
});
