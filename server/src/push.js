// Web Push for offline users. The payload never contains message content —
// the server only has ciphertext anyway — just enough metadata (conv id,
// sender ref, room name) for the service worker to show "new message from X".
// Transport to the browser is encrypted per RFC 8291, so the push service
// (FCM etc.) cannot read even that metadata.
import webpush from 'web-push';
import { q } from './db.js';

let publicKey = null;

export async function initPush() {
  let r = await q('SELECT public_key, private_key FROM vapid WHERE id = 1');
  if (!r.rows[0]) {
    const k = webpush.generateVAPIDKeys();
    await q(
      'INSERT INTO vapid (id, public_key, private_key) VALUES (1, $1, $2) ON CONFLICT (id) DO NOTHING',
      [k.publicKey, k.privateKey],
    );
    r = await q('SELECT public_key, private_key FROM vapid WHERE id = 1');
  }
  const { public_key: pub, private_key: priv } = r.rows[0];
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@pathy.invalid', pub, priv);
  publicKey = pub;
}

export const vapidPublicKey = () => publicKey;

export async function pushToUser(ref, payload) {
  if (!publicKey || !ref.startsWith('u:')) return;
  const r = await q(
    `SELECT s.id, s.endpoint, s.p256dh, s.auth FROM push_subs s
     JOIN users u ON u.id = s.user_id WHERE u.username = $1`,
    [ref.slice(2)],
  );
  await Promise.all(r.rows.map(async (sub) => {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload),
        { TTL: 24 * 3600, urgency: 'high' },
      );
    } catch (err) {
      // subscription expired or revoked — drop it
      if (err.statusCode === 404 || err.statusCode === 410) {
        await q('DELETE FROM push_subs WHERE id = $1', [sub.id]).catch(() => {});
      }
    }
  }));
}
