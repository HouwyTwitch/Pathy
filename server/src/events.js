// In-process fan-out: REST handlers publish, the WebSocket layer and bot
// long-pollers subscribe. Also persists bot updates so bots receive events
// even while offline (Telegram getUpdates semantics), and wakes offline
// users' devices via Web Push for new messages.
import { EventEmitter } from 'node:events';
import { q, memberRefs } from './db.js';
import { isOnline } from './ws.js';
import { pushToUser } from './push.js';

export const bus = new EventEmitter();
bus.setMaxListeners(0);

// Deliver an event to a set of principal refs. Users get it via WS (if
// online); bots get a persisted bot_update row + a poke for long-pollers.
// Offline users get a Web Push wake-up for new messages (metadata only —
// the server has no plaintext to leak).
export async function deliver(refs, event, { skipBotUpdate = false } = {}) {
  const botNames = [];
  for (const ref of refs) {
    bus.emit(`ws:${ref}`, event);
    if (ref.startsWith('b:')) botNames.push(ref.slice(2));
  }
  if (event.type === 'message') {
    for (const ref of refs) {
      if (ref.startsWith('u:') && ref !== event.message?.senderRef && !isOnline(ref)) {
        pushToUser(ref, {
          convId: event.convId,
          from: event.message?.senderRef || '',
          convType: event.convType || 'dm',
          convName: event.convName || null,
        }).catch(() => {});
      }
    }
  }
  if (skipBotUpdate || botNames.length === 0) return;
  const bots = await q('SELECT id, username FROM bots WHERE username = ANY($1)', [botNames]);
  for (const bot of bots.rows) {
    await q('INSERT INTO bot_updates (bot_id, type, payload) VALUES ($1, $2, $3)', [
      bot.id, event.type, event,
    ]);
    bus.emit(`bot:${bot.id}`);
  }
}

export async function deliverToConversation(convId, event, opts) {
  await deliver(await memberRefs(convId), event, opts);
}
