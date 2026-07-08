// Sticker packs: custom packs (user-uploaded images) and packs imported
// from Telegram via the Bot API (requires TELEGRAM_BOT_TOKEN on the server).
// Sticker images are profile-grade data like avatars — any logged-in user
// can fetch them and install a pack they saw in a chat. The messages that
// reference stickers remain end-to-end encrypted.
import { Router, raw } from 'express';
import { randomUUID } from 'node:crypto';
import { q, pool } from '../db.js';
import { HttpError, asyncRoute } from '../util.js';
import { rateLimit } from '../ratelimit.js';

export const stickers = Router();

const STICKER_MIMES = ['image/webp', 'image/png', 'image/jpeg', 'video/webm'];
const MAX_STICKER_BYTES = 1024 * 1024;    // webm video stickers can be chunky
const MAX_PACK_STICKERS = 120;
const MAX_INSTALLED_PACKS = 200;

const packMeta = (p, mine) => ({
  id: p.id, slug: p.slug, title: p.title, origin: p.origin, mine: !!mine,
});

async function packStickers(packId) {
  const r = await q(
    'SELECT id, emoji, mime, w, h FROM stickers WHERE pack_id = $1 ORDER BY pos, id',
    [packId],
  );
  return r.rows;
}

async function loadPack(id) {
  if (!Number.isInteger(id) || id < 1) throw new HttpError(400, 'bad pack id');
  const r = await q('SELECT id, slug, title, origin, owner_id FROM sticker_packs WHERE id = $1', [id]);
  if (!r.rows[0]) throw new HttpError(404, 'pack not found');
  return r.rows[0];
}

async function installPack(userId, packId) {
  const count = await q('SELECT count(*)::int AS n FROM user_sticker_packs WHERE user_id = $1', [userId]);
  if (count.rows[0].n >= MAX_INSTALLED_PACKS) throw new HttpError(400, 'too many installed packs');
  const pos = await q(
    'SELECT COALESCE(max(pos), -1) + 1 AS p FROM user_sticker_packs WHERE user_id = $1', [userId],
  );
  await q(
    `INSERT INTO user_sticker_packs (user_id, pack_id, pos) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, pack_id) DO NOTHING`,
    [userId, packId, pos.rows[0].p],
  );
}

// ---- my installed packs (with sticker metadata, not image data)

stickers.get('/packs', asyncRoute(async (req, res) => {
  const r = await q(
    `SELECT p.id, p.slug, p.title, p.origin, p.owner_id
     FROM user_sticker_packs up JOIN sticker_packs p ON p.id = up.pack_id
     WHERE up.user_id = $1 ORDER BY up.pos, up.added_at`,
    [req.user.id],
  );
  const packs = [];
  for (const p of r.rows) {
    packs.push({ ...packMeta(p, p.owner_id === req.user.id), stickers: await packStickers(p.id) });
  }
  res.json({ packs });
}));

stickers.post('/packs', asyncRoute(async (req, res) => {
  const title = String(req.body?.title || '').trim();
  if (title.length < 1 || title.length > 64) throw new HttpError(400, 'title required (1-64 chars)');
  const r = await q(
    `INSERT INTO sticker_packs (slug, title, owner_id, origin) VALUES ($1, $2, $3, 'custom')
     RETURNING id, slug, title, origin`,
    [`c:${randomUUID()}`, title, req.user.id],
  );
  await installPack(req.user.id, r.rows[0].id);
  res.status(201).json({ pack: { ...packMeta(r.rows[0], true), stickers: [] } });
}));

// Pack preview (for "add this pack" from a received sticker).
stickers.get('/packs/:id', asyncRoute(async (req, res) => {
  const pack = await loadPack(Number(req.params.id));
  const installed = await q(
    'SELECT 1 FROM user_sticker_packs WHERE user_id = $1 AND pack_id = $2',
    [req.user.id, pack.id],
  );
  res.json({
    pack: {
      ...packMeta(pack, pack.owner_id === req.user.id),
      installed: installed.rowCount > 0,
      stickers: await packStickers(pack.id),
    },
  });
}));

stickers.post('/packs/:id/install', asyncRoute(async (req, res) => {
  const pack = await loadPack(Number(req.params.id));
  await installPack(req.user.id, pack.id);
  res.status(201).json({ ok: true });
}));

// Owner: delete the pack for everyone. Non-owner: just uninstall.
stickers.delete('/packs/:id', asyncRoute(async (req, res) => {
  const pack = await loadPack(Number(req.params.id));
  if (pack.owner_id === req.user.id) {
    await q('DELETE FROM sticker_packs WHERE id = $1', [pack.id]);
  } else {
    await q('DELETE FROM user_sticker_packs WHERE user_id = $1 AND pack_id = $2', [req.user.id, pack.id]);
  }
  res.json({ ok: true });
}));

// ---- stickers within a pack

stickers.post(
  '/packs/:id/stickers',
  rateLimit({ windowMs: 60_000, max: 60, keyFn: (req) => req.user.ref }),
  raw({ type: ['image/*', 'video/webm'], limit: MAX_STICKER_BYTES }),
  asyncRoute(async (req, res) => {
    const pack = await loadPack(Number(req.params.id));
    if (pack.owner_id !== req.user.id) throw new HttpError(403, 'only the pack owner adds stickers');
    const mime = String(req.headers['content-type'] || '').split(';')[0].trim();
    if (!STICKER_MIMES.includes(mime)) throw new HttpError(400, 'sticker must be webp, png, jpeg or webm');
    if (!Buffer.isBuffer(req.body) || req.body.length < 100) throw new HttpError(400, 'empty sticker');
    const count = await q('SELECT count(*)::int AS n FROM stickers WHERE pack_id = $1', [pack.id]);
    if (count.rows[0].n >= MAX_PACK_STICKERS) throw new HttpError(400, `pack is full (max ${MAX_PACK_STICKERS})`);
    const emoji = String(req.query.emoji || '').slice(0, 16) || null;
    const w = Number(req.query.w) || null;
    const h = Number(req.query.h) || null;
    const r = await q(
      `INSERT INTO stickers (pack_id, pos, emoji, mime, w, h, data)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, emoji, mime, w, h`,
      [pack.id, count.rows[0].n, emoji, mime, w, h, req.body],
    );
    res.status(201).json({ sticker: r.rows[0] });
  }),
);

stickers.delete('/sticker/:sid', asyncRoute(async (req, res) => {
  const sid = Number(req.params.sid);
  if (!Number.isInteger(sid) || sid < 1) throw new HttpError(400, 'bad sticker id');
  const r = await q(
    `DELETE FROM stickers s USING sticker_packs p
     WHERE s.id = $1 AND p.id = s.pack_id AND p.owner_id = $2 RETURNING s.id`,
    [sid, req.user.id],
  );
  if (r.rowCount === 0) throw new HttpError(404, 'sticker not found or not yours');
  res.json({ ok: true });
}));

// The image itself. Sticker ids are immutable, so cache hard.
stickers.get('/sticker/:sid/image', asyncRoute(async (req, res) => {
  const sid = Number(req.params.sid);
  if (!Number.isInteger(sid) || sid < 1) throw new HttpError(400, 'bad sticker id');
  const r = await q('SELECT mime, data FROM stickers WHERE id = $1', [sid]);
  if (!r.rows[0]) throw new HttpError(404, 'sticker not found');
  res.set({
    'Content-Type': r.rows[0].mime,
    'Cache-Control': 'private, max-age=31536000, immutable',
  });
  res.send(r.rows[0].data);
}));

// ---- Telegram import

const TG_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

function parseTgPackName(input) {
  const s = String(input || '').trim();
  const m = /(?:t\.me\/addstickers\/|tg:\/\/addstickers\?set=)([A-Za-z0-9_]+)/.exec(s);
  const name = m ? m[1] : s;
  if (!TG_NAME_RE.test(name)) throw new HttpError(400, 'bad pack name — use the t.me/addstickers link or the pack short name');
  return name;
}

async function tg(token, method, params) {
  const url = new URL(`https://api.telegram.org/bot${token}/${method}`);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  const data = await res.json().catch(() => null);
  if (!data?.ok) {
    throw new HttpError(502, `telegram: ${data?.description || `http ${res.status}`}`);
  }
  return data.result;
}

stickers.post(
  '/import-telegram',
  rateLimit({ windowMs: 60_000, max: 4, keyFn: (req) => req.user.ref }),
  asyncRoute(async (req, res) => {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      throw new HttpError(501, 'telegram import is not configured — set TELEGRAM_BOT_TOKEN on the server');
    }
    const name = parseTgPackName(req.body?.name);
    const slug = `tg:${name.toLowerCase()}`;

    // Already imported by anyone? Just install it.
    const existing = await q(
      'SELECT id, slug, title, origin, owner_id FROM sticker_packs WHERE slug = $1', [slug],
    );
    if (existing.rows[0]) {
      await installPack(req.user.id, existing.rows[0].id);
      return res.json({
        pack: {
          ...packMeta(existing.rows[0], existing.rows[0].owner_id === req.user.id),
          stickers: await packStickers(existing.rows[0].id),
        },
        existing: true,
      });
    }

    const set = await tg(token, 'getStickerSet', { name });
    const usable = (set.stickers || [])
      .filter((s) => !s.is_animated) // .tgs (Lottie) has no web-native renderer
      .slice(0, MAX_PACK_STICKERS);
    if (usable.length === 0) {
      throw new HttpError(400, 'this pack has only animated (.tgs) stickers, which cannot be imported');
    }

    // Download with limited concurrency; skip oversized/broken files.
    const files = new Array(usable.length).fill(null);
    let next = 0;
    await Promise.all(Array.from({ length: 4 }, async () => {
      for (;;) {
        const i = next++;
        if (i >= usable.length) return;
        const s = usable[i];
        try {
          const f = await tg(token, 'getFile', { file_id: s.file_id });
          if (!f.file_path || (f.file_size || 0) > MAX_STICKER_BYTES) continue;
          const dl = await fetch(
            `https://api.telegram.org/file/bot${token}/${f.file_path}`,
            { signal: AbortSignal.timeout(20_000) },
          );
          if (!dl.ok) continue;
          const buf = Buffer.from(await dl.arrayBuffer());
          if (buf.length < 100 || buf.length > MAX_STICKER_BYTES) continue;
          files[i] = {
            emoji: s.emoji || null,
            mime: s.is_video ? 'video/webm' : 'image/webp',
            w: s.width || null,
            h: s.height || null,
            data: buf,
          };
        } catch { /* skip this sticker */ }
      }
    }));
    const got = files.filter(Boolean);
    if (got.length === 0) throw new HttpError(502, 'could not download any stickers from telegram');

    const client = await pool.connect();
    let pack;
    try {
      await client.query('BEGIN');
      const r = await client.query(
        `INSERT INTO sticker_packs (slug, title, owner_id, origin) VALUES ($1, $2, $3, 'telegram')
         RETURNING id, slug, title, origin`,
        [slug, String(set.title || name).slice(0, 64), req.user.id],
      );
      pack = r.rows[0];
      let pos = 0;
      for (const f of got) {
        await client.query(
          'INSERT INTO stickers (pack_id, pos, emoji, mime, w, h, data) VALUES ($1, $2, $3, $4, $5, $6, $7)',
          [pack.id, pos++, f.emoji, f.mime, f.w, f.h, f.data],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.code === '23505') throw new HttpError(409, 'pack was just imported by someone else — try again');
      throw err;
    } finally {
      client.release();
    }
    await installPack(req.user.id, pack.id);
    res.status(201).json({
      pack: { ...packMeta(pack, true), stickers: await packStickers(pack.id) },
      imported: got.length,
      skipped: (set.stickers || []).length - got.length,
    });
  }),
);
