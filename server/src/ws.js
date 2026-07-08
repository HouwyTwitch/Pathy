// Realtime push for web clients. Auth happens via the first frame
// ({ type:'auth', token }) so session tokens never appear in URLs or logs.
// Presence is only revealed to people who share a conversation with the
// user, and only when their showOnline privacy setting allows it.
import { WebSocketServer } from 'ws';
import { q, memberOf, memberRefs } from './db.js';
import { sessionFromToken } from './auth.js';
import { bus } from './events.js';

const online = new Map(); // ref -> Set<ws>

export const isOnline = (ref) => online.has(ref);

async function contactsOf(ref) {
  const r = await q(
    `SELECT DISTINCT b.ref FROM members a JOIN members b ON a.conv_id = b.conv_id
     WHERE a.ref = $1 AND b.ref <> $1 AND b.ref LIKE 'u:%'`,
    [ref],
  );
  return r.rows.map((x) => x.ref);
}

async function broadcastPresence(user, isNowOnline) {
  const settings = user.settings || {};
  if (settings.showOnline === false) return;
  for (const contact of await contactsOf(user.ref)) {
    bus.emit(`ws:${contact}`, { type: 'presence', ref: user.ref, online: isNowOnline });
  }
}

export function attachWs(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws', maxPayload: 4096 });

  wss.on('connection', (ws) => {
    let user = null;
    let onEvent = null;
    const memberCache = new Map(); // convId -> { ok, ts } (typing membership checks)
    const typingTs = new Map();    // convId -> last relayed typing timestamp

    const authTimer = setTimeout(() => { if (!user) ws.close(4401, 'auth timeout'); }, 10_000);

    ws.on('message', async (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return ws.close(4400, 'bad frame');
      }
      if (!user) {
        if (msg.type !== 'auth') return ws.close(4401, 'auth required');
        user = await sessionFromToken(msg.token);
        if (!user) return ws.close(4401, 'invalid token');
        clearTimeout(authTimer);

        onEvent = (event) => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
        };
        bus.on(`ws:${user.ref}`, onEvent);

        let conns = online.get(user.ref);
        if (!conns) {
          conns = new Set();
          online.set(user.ref, conns);
          broadcastPresence(user, true).catch(() => {});
        }
        conns.add(ws);
        ws.send(JSON.stringify({ type: 'ready', ref: user.ref }));
        return;
      }
      if (msg.type === 'ping') return ws.send(JSON.stringify({ type: 'pong' }));
      // Typing indicators: relayed live to other members, never persisted.
      if (msg.type === 'typing' && Number.isInteger(msg.convId)) {
        const now = Date.now();
        if (now - (typingTs.get(msg.convId) || 0) < 1500) return;
        typingTs.set(msg.convId, now);
        let cached = memberCache.get(msg.convId);
        if (!cached || now - cached.ts > 60_000) {
          cached = { ok: !!(await memberOf(msg.convId, user.ref)), ts: now };
          memberCache.set(msg.convId, cached);
        }
        if (!cached.ok) return;
        for (const ref of await memberRefs(msg.convId)) {
          if (ref !== user.ref && ref.startsWith('u:')) {
            bus.emit(`ws:${ref}`, { type: 'typing', convId: msg.convId, ref: user.ref });
          }
        }
      }
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      if (!user) return;
      if (onEvent) bus.off(`ws:${user.ref}`, onEvent);
      const conns = online.get(user.ref);
      if (conns) {
        conns.delete(ws);
        if (conns.size === 0) {
          online.delete(user.ref);
          broadcastPresence(user, false).catch(() => {});
        }
      }
    });
  });

  // Drop dead connections so presence stays truthful.
  const interval = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000);
  interval.unref();
  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
  });

  return wss;
}
