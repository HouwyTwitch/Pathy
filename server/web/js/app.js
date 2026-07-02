// Pathy web client. Rendering is plain DOM (no innerHTML for any
// user-controlled string), state transitions re-render coarsely; text inputs
// carry a data-fid marker so value/focus/selection survive re-renders, and
// the message box keeps its scroll position across re-renders.
import { api, hasToken, setToken, onWsEvent, connectWs, disconnectWs } from './api.js';
import * as store from './store.js';

const state = store.state;
const ui = {
  view: 'chats',          // chats | settings | bots
  activeConvId: null,
  msgs: new Map(),        // convId -> [{ id, localId?, pending?, senderRef, ts, body|error, verified, editedAt }]
  loaded: new Set(),      // convIds whose history has been fetched
  unread: new Map(),      // convId -> count
  drafts: new Map(),      // convId -> composer draft
  editing: null,          // { convId, id, prevDraft }
  picker: null,           // null | 'emoji' | 'stickers'
  select: null,           // Set of selected message ids (active conv only)
  searchQuery: '',
  searchResults: null,
  modal: null,
};

let localSeq = 0;        // ids for optimistic local echoes
let searchSeq = 0;       // drops stale search responses
let rec = null;          // active voice recording
const lastReadSent = new Map(); // convId -> last read id reported to the server

const app = document.getElementById('app');

// ------------------------------------------------------------- dom helpers

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else if (k === 'hidden') el.hidden = !!v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

// Minimal stroke icon set (24x24 viewBox). Static markup only — never fed
// user-controlled strings.
const ICONS = {
  search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  compose: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  bot: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
  send: '<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>',
  paperclip: '<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  info: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
  back: '<polyline points="15 18 9 12 15 6"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  file: '<path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  checks: '<path d="M18 6 7 17l-5-5"/><path d="m22 10-7.5 7.5L13 16"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  radio: '<circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49m-8.48-.01a6 6 0 0 1 0-8.49m11.31-2.82a10 10 0 0 1 0 14.14m-14.14 0a10 10 0 0 1 0-14.14"/>',
  rotate: '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  pencil: '<path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/>',
  smile: '<circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/>',
  mic: '<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>',
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
  pin: '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z"/>',
  up: '<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>',
  down: '<line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/>',
  camera: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
  more: '<circle cx="12" cy="12" r="1.4" fill="currentColor"/><circle cx="19" cy="12" r="1.4" fill="currentColor"/><circle cx="5" cy="12" r="1.4" fill="currentColor"/>',
};

function icon(name, cls = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  if (cls) svg.setAttribute('class', cls);
  svg.innerHTML = ICONS[name]; // static markup from the table above
  return svg;
}

function toast(text, isError = false) {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const t = h('div', { class: `toast${isError ? ' err' : ''}` }, text);
  document.body.append(t);
  setTimeout(() => t.remove(), isError ? 5000 : 2500);
}

const errMsg = (err) => err?.message || 'something went wrong';

// Long-press support for touch devices that don't synthesize contextmenu.
function addLongPress(el, fn) {
  let timer = null;
  let fired = false;
  el.addEventListener('touchstart', () => {
    fired = false;
    timer = setTimeout(() => { timer = null; fired = true; fn(); }, 480);
  }, { passive: true });
  const cancel = () => { if (timer) clearTimeout(timer); timer = null; };
  el.addEventListener('touchmove', cancel, { passive: true });
  el.addEventListener('touchcancel', cancel);
  el.addEventListener('touchend', (e) => {
    cancel();
    if (fired) { e.preventDefault(); e.stopPropagation(); }
  });
}

// ------------------------------------------------------------ notifications

let swReg = null; // service worker registration (notifications on Android PWA)
const liveNotifs = new Map(); // convId -> [Notification] (page-created ones)

// Preference lives on this device. Default: on, once the browser permission
// has been granted (granting happens via the Settings toggle).
function notifyEnabled() {
  const v = localStorage.getItem('pathy.notify');
  if (v === 'off') return false;
  return typeof Notification !== 'undefined' && Notification.permission === 'granted';
}

function notifBody(m) {
  if (m.error) return 'New message';
  const b = m.body || {};
  if (b.t === 'sticker') return `Sticker ${b.emoji || ''}`;
  if (b.t === 'file') {
    if (b.kind === 'voice') return 'Voice message';
    return (b.mime || '').startsWith('image/') ? 'Photo' : (b.name || 'File');
  }
  return String(b.text || '').slice(0, 140);
}

// Local notification while the app is open but in the background (a hidden
// tab, an unfocused window). When the app is fully closed, the server-side
// Web Push wakes the service worker instead (see sw.js).
function notifyNewMessage(conv, m) {
  if (!notifyEnabled()) return;
  if (document.hasFocus() && !document.hidden) return;
  const sender = displayName(m.senderRef);
  const title = conv.type === 'dm' ? sender : `${sender} — ${convTitle(conv)}`;
  const opts = {
    body: notifBody(m),
    tag: `pathy-${conv.id}`,
    icon: '/icon.svg',
    data: { convId: conv.id },
  };
  try {
    const n = new Notification(title, opts);
    n.onclick = () => {
      try { window.focus(); } catch { /* mobile */ }
      openConv(conv.id);
      n.close();
    };
    if (!liveNotifs.has(conv.id)) liveNotifs.set(conv.id, []);
    liveNotifs.get(conv.id).push(n);
  } catch {
    // Android: page-created Notification is forbidden — go through the SW
    swReg?.showNotification?.(title, { ...opts, badge: '/icon.svg' }).catch(() => {});
  }
}

function clearNotifications(convId) {
  for (const n of liveNotifs.get(convId) || []) { try { n.close(); } catch { /* gone */ } }
  liveNotifs.delete(convId);
  swReg?.getNotifications?.({ tag: `pathy-${convId}` })
    .then((list) => list.forEach((n) => n.close()))
    .catch(() => {});
}

const b64uToBytes = (s) => {
  const b64 = s.replaceAll('-', '+').replaceAll('_', '/');
  return Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0));
};

// Keep the Web Push subscription in sync with the preference. With push,
// notifications reach the device even when the (installed) app is closed.
async function syncPushSubscription(enable) {
  try {
    if (!swReg?.pushManager) return;
    const existing = await swReg.pushManager.getSubscription();
    if (!enable) {
      if (existing) {
        api.deletePushSub(existing.endpoint).catch(() => {});
        await existing.unsubscribe();
      }
      return;
    }
    const { key } = await api.vapidKey();
    if (!key) return;
    const sub = existing || await swReg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: b64uToBytes(key),
    });
    const j = sub.toJSON();
    await api.savePushSub({ endpoint: j.endpoint, keys: j.keys });
  } catch { /* push unsupported (no push service, permission revoked, …) */ }
}

// ---------------------------------------------------------------- avatars

const avatarCache = new Map(); // cache key -> { url } | { loading } | { missing }

function cachedImage(key, fetcher) {
  let e = avatarCache.get(key);
  if (!e) {
    e = { loading: true };
    avatarCache.set(key, e);
    fetcher().then((blob) => {
      e.url = URL.createObjectURL(blob);
      e.loading = false;
      renderMain();
    }).catch(() => { e.missing = true; e.loading = false; });
  }
  return e.url || null;
}

// av: { ref, rev } for users/bots, { conv, rev } for room photos.
function avatarFor(name, kind = 'user', online = false, av = null) {
  const hue = [...name].reduce((a, c) => a + c.charCodeAt(0) * 7, 0) % 8;
  let url = null;
  if (av?.rev) {
    url = av.conv != null
      ? cachedImage(`conv:${av.conv}:${av.rev}`, () => api.fetchConvAvatar(av.conv, av.rev))
      : cachedImage(`${av.ref}:${av.rev}`, () => api.fetchAvatar(av.ref, av.rev));
  }
  const glyph = url ? h('img', { class: 'avatar-img', src: url, alt: '', draggable: 'false' })
    : kind === 'bot' ? icon('bot', 'av-icon')
      : kind === 'channel' ? icon('radio', 'av-icon')
        : kind === 'group' ? icon('users', 'av-icon')
          : (name[0] || '?').toUpperCase();
  const el = h('div', { class: `avatar av${hue}${url ? ' has-img' : ''}` }, glyph);
  if (online) el.append(h('span', { class: 'dot' }));
  return el;
}

function memberAv(conv, ref) {
  const m = conv?.members?.find((x) => x.ref === ref);
  return m && m.avatarRev ? { ref, rev: m.avatarRev } : null;
}

// The avatar shown for a conversation row/header: peer photo for DMs, the
// room photo for groups & channels.
function convAv(conv) {
  const peer = dmPeer(conv);
  if (peer) return memberAv(conv, peer);
  return conv.avatarRev ? { conv: conv.id, rev: conv.avatarRev } : null;
}

const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function fmtDay(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], {
    day: 'numeric', month: 'long',
    ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}),
  });
}

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtDur(s) {
  const sec = Math.max(0, Math.floor(s));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

function displayName(ref) {
  return ref === state.me?.ref ? 'you' : ref.slice(2);
}

function convTitle(conv) {
  if (conv.type !== 'dm') return conv.name || '(room)';
  const other = conv.members.find((m) => m.ref !== state.me.ref);
  return other ? displayName(other.ref) : 'dm';
}

function dmPeer(conv) {
  return conv.type === 'dm' ? conv.members.find((m) => m.ref !== state.me.ref)?.ref : null;
}

function avatarKind(conv) {
  if (conv.type !== 'dm') return conv.type;
  return dmPeer(conv)?.startsWith('b:') ? 'bot' : 'user';
}

// Turn plain text into text nodes + safe anchors for http(s) links.
const URL_RE = /https?:\/\/[^\s<>"']+/g;
function linkify(text) {
  const parts = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const trimmed = m[0].replace(/[),.;:!?\]]+$/, '');
    parts.push(h('a', { href: trimmed, target: '_blank', rel: 'noopener noreferrer nofollow' }, trimmed));
    if (trimmed.length < m[0].length) parts.push(m[0].slice(trimmed.length));
    last = m.index + m[0].length;
  }
  parts.push(text.slice(last));
  return parts;
}

// True for messages that are just 1-3 emoji — rendered big, like Telegram.
function emojiOnly(text) {
  if (!text || text.length > 24) return false;
  try {
    const seg = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text.trim())];
    if (seg.length === 0 || seg.length > 3) return false;
    return seg.every((s) => /\p{Extended_Pictographic}/u.test(s.segment));
  } catch {
    return false;
  }
}

// --------------------------------------------------------- message list ops

function convMsgs(convId) {
  let list = ui.msgs.get(convId);
  if (!list) { list = []; ui.msgs.set(convId, list); }
  return list;
}

// Single entry point for adding/merging messages. Dedupes by server id (as a
// string — Postgres bigints arrive as strings) and by local echo id, so the
// WS echo of an own message can never appear alongside the optimistic copy.
function upsertMessage(convId, msg) {
  const list = convMsgs(convId);
  const id = msg.id != null ? String(msg.id) : null;
  const existing = list.find((m) =>
    (id && m.id != null && String(m.id) === id) || (msg.localId && m.localId === msg.localId));
  if (existing) {
    Object.assign(existing, msg);
    return list;
  }
  // The WS echo of an own message can land before the HTTP send response —
  // merge it into the optimistic copy instead of flashing a duplicate.
  if (id && !msg.localId && msg.senderRef === state.me?.ref) {
    const echo = list.find((m) => m.pending && m.id == null && m.senderRef === msg.senderRef
      && m.body?.t === msg.body?.t
      && (m.body?.t !== 'text' || m.body.text === msg.body?.text)
      && (m.body?.t !== 'sticker' || m.body.emoji === msg.body?.emoji));
    if (echo) {
      Object.assign(echo, msg, { pending: false, uploading: undefined });
      return list;
    }
  }
  list.push(msg);
  return list;
}

function sortMsgs(convId) {
  convMsgs(convId).sort((a, b) =>
    (new Date(a.ts).getTime() - new Date(b.ts).getTime())
    || (Number(a.id ?? Infinity) - Number(b.id ?? Infinity)));
}

// Reconcile an optimistic echo with the server's response. If the WS echo
// already landed under the real id, drop the local copy instead.
function resolveEcho(convId, localId, sent) {
  const list = convMsgs(convId);
  const mine = list.find((m) => m.localId === localId);
  const dupe = list.find((m) => m.id != null && String(m.id) === String(sent.id) && m !== mine);
  if (dupe && mine) list.splice(list.indexOf(mine), 1);
  else if (mine) Object.assign(mine, { id: sent.id, ts: sent.ts, pending: false, uploading: undefined, ...(sent.body ? { body: sent.body } : {}) });
}

function dropEcho(convId, localId) {
  const list = convMsgs(convId);
  const i = list.findIndex((m) => m.localId === localId);
  if (i >= 0) list.splice(i, 1);
}

// ------------------------------------------------------------ read cursors

function maxOtherRead(conv) {
  let max = 0;
  for (const [ref, id] of Object.entries(conv.reads || {})) {
    if (ref !== state.me.ref) max = Math.max(max, Number(id) || 0);
  }
  return max;
}

// Report "I've seen everything up to the newest message" for the open chat.
function markRead(conv) {
  if (!conv || document.visibilityState !== 'visible') return;
  if (ui.view !== 'chats' || ui.activeConvId !== conv.id) return;
  let maxId = 0;
  for (const m of ui.msgs.get(conv.id) || []) {
    if (m.id != null) maxId = Math.max(maxId, Number(m.id));
  }
  if (!maxId || (lastReadSent.get(conv.id) || 0) >= maxId) return;
  lastReadSent.set(conv.id, maxId);
  ui.unread.delete(conv.id);
  api.markRead(conv.id, maxId).catch(() => lastReadSent.delete(conv.id));
}

// ---------------------------------------------------------------- screens

function render() {
  app.replaceChildren();
  if (!state.me) return renderAuth();
  renderMain();
}

// ---- auth / unlock

let authMode = 'login';

function renderAuth({ unlockOnly = false } = {}) {
  const err = h('div', { class: 'error-text' });
  const user = h('input', { placeholder: 'username (a-z, 0-9, _)', autocomplete: 'username', maxlength: '32', autocapitalize: 'none', spellcheck: 'false' });
  const pass = h('input', { placeholder: 'password', type: 'password', autocomplete: 'current-password' });
  const btnLabel = unlockOnly ? 'Unlock' : (authMode === 'login' ? 'Log in' : 'Create account');
  const btn = h('button', { class: 'primary' }, btnLabel);

  const submit = async () => {
    err.textContent = '';
    btn.disabled = true;
    btn.textContent = 'deriving keys…';
    try {
      if (unlockOnly) await store.unlock(pass.value);
      else if (authMode === 'login') await store.login(user.value.trim().toLowerCase(), pass.value);
      else {
        if (pass.value.length < 8) throw new Error('password must be at least 8 characters');
        await store.register(user.value.trim().toLowerCase(), pass.value);
      }
      await enterApp();
    } catch (e) {
      err.textContent = errMsg(e);
      btn.disabled = false;
      btn.textContent = btnLabel;
    }
  };

  pass.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  btn.addEventListener('click', submit);

  const card = h('div', { class: 'auth-card' },
    h('div', { class: 'auth-logo' }, icon('lock')),
    h('h1', {}, 'Pathy'),
    h('div', { class: 'sub muted' },
      'End-to-end encrypted messenger with post-quantum cryptography. ',
      'Keys are generated in your browser — the server never sees plaintext.'),
    unlockOnly
      ? h('div', { class: 'muted center' },
          `Enter your password to decrypt your keys, ${state.me?.username || ''}`)
      : h('div', { class: 'auth-tabs' },
          h('button', { class: authMode === 'login' ? 'active' : '', onclick: () => { authMode = 'login'; render(); } }, 'Log in'),
          h('button', { class: authMode === 'register' ? 'active' : '', onclick: () => { authMode = 'register'; render(); } }, 'Register')),
    ...(unlockOnly ? [] : [user]),
    pass, btn, err,
    unlockOnly
      ? h('button', { class: 'ghost', onclick: async () => { await store.logout(); render(); } }, 'Log out instead')
      : null,
  );
  app.replaceChildren(h('div', { class: 'auth-wrap' }, card));
  (unlockOnly ? pass : user).focus();
}

// ---- main layout

function renderMain() {
  // preserve focus + caret of marked inputs across coarse re-renders
  const active = document.activeElement;
  const fid = active?.dataset?.fid || null;
  const sel = fid && typeof active.selectionStart === 'number'
    ? [active.selectionStart, active.selectionEnd] : null;
  // preserve message-box scroll: stick to the bottom when the user is there,
  // otherwise restore the exact offset (fixes the chat jumping on updates)
  const oldBox = app.querySelector('.messages');
  const oldConv = oldBox?.dataset.conv;
  const stickBottom = !oldBox
    || oldBox.scrollTop + oldBox.clientHeight >= oldBox.scrollHeight - 48;
  const prevScroll = oldBox?.scrollTop ?? 0;

  const sidebar = h('div', { class: 'sidebar' }, renderSidebarTop(), renderSearchOrChats(), renderSidebarBottom());
  const main = h('div', { class: 'main' });
  if (ui.view === 'settings') main.append(renderSettings());
  else if (ui.view === 'bots') main.append(renderBots());
  else if (ui.activeConvId) main.append(...renderChat());
  else {
    main.append(h('div', { class: 'empty-state' },
      h('div', { class: 'empty-icon' }, icon('lock')),
      h('div', {}, 'Select a chat, or search for people to message'),
      h('div', { class: 'muted' }, 'Everything is encrypted end-to-end')));
  }

  const chatOpen = ui.view !== 'chats' || !!ui.activeConvId;
  app.replaceChildren(h('div', { class: `layout${chatOpen ? ' chat-open' : ''}` }, sidebar, main));
  if (ui.modal) app.append(ui.modal);

  const box = app.querySelector('.messages');
  if (box) {
    const sameConv = oldBox && oldConv === box.dataset.conv;
    if (!sameConv || stickBottom) box.scrollTop = box.scrollHeight;
    else box.scrollTop = prevScroll;
  }
  if (fid) {
    const el = app.querySelector(`[data-fid="${fid}"]`);
    if (el) {
      el.focus({ preventScroll: true });
      if (sel) { try { el.setSelectionRange(sel[0], sel[1]); } catch { /* not a text input */ } }
    }
  }
  const unreadTotal = [...ui.unread.values()].reduce((a, b) => a + b, 0);
  document.title = unreadTotal > 0 ? `(${unreadTotal}) Pathy` : 'Pathy';
}

// Re-render just the sidebar list (used while typing in search, so the
// input element itself is never rebuilt mid-keystroke).
function renderList() {
  const list = app.querySelector('.chat-list');
  if (list) list.replaceWith(renderSearchOrChats());
}

function runSearch(raw) {
  ui.searchQuery = raw;
  const q = raw.trim().toLowerCase();
  const seq = ++searchSeq;
  if (q.length < 2) {
    ui.searchResults = null;
    renderList();
    return;
  }
  api.search(q).then(({ results }) => {
    if (seq !== searchSeq) return; // a newer query is in flight
    ui.searchResults = results;
    renderList();
  }).catch(() => { /* transient search errors */ });
}

function renderSidebarTop() {
  const input = h('input', {
    class: 'search-input',
    'data-fid': 'search',
    type: 'search',
    placeholder: 'Search people & bots',
    autocapitalize: 'none',
    spellcheck: 'false',
    value: ui.searchQuery,
    oninput: (e) => runSearch(e.target.value),
    onkeydown: (e) => {
      if (e.key === 'Escape') { e.target.value = ''; runSearch(''); }
    },
  });
  return h('div', { class: 'sidebar-top' },
    h('div', { class: 'search-box' }, icon('search', 'search-icon'), input),
    h('button', { class: 'icon-btn', title: 'New group / channel', 'aria-label': 'New group / channel', onclick: () => openCreateRoomModal() }, icon('compose')),
  );
}

function msgPreview(m) {
  if (!m) return '';
  if (m.error) return '…';
  const who = m.senderRef === state.me.ref ? 'you: ' : '';
  const b = m.body || {};
  if (b.t === 'sticker') return `${who}Sticker ${b.emoji || ''}`;
  if (b.t === 'file') {
    if (b.kind === 'voice') return `${who}Voice message`;
    return `${who}${(b.mime || '').startsWith('image/') ? 'Photo' : (b.name || 'File')}`;
  }
  return `${who}${b.text ?? ''}`;
}

// ---- pinned chats

const pinnedIds = () => state.conversations
  .filter((c) => c.pinOrder != null)
  .sort((a, b) => a.pinOrder - b.pinOrder)
  .map((c) => c.id);

async function savePins(order) {
  try {
    await api.savePins(order);
    await refreshConversations();
  } catch (e) { toast(errMsg(e), true); }
}

function togglePin(conv) {
  const pins = pinnedIds();
  const i = pins.indexOf(conv.id);
  if (i >= 0) pins.splice(i, 1);
  else pins.unshift(conv.id); // newly pinned goes on top, like Telegram
  savePins(pins);
}

function movePin(conv, dir) {
  const pins = pinnedIds();
  const i = pins.indexOf(conv.id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= pins.length) return;
  [pins[i], pins[j]] = [pins[j], pins[i]];
  savePins(pins);
}

function openChatActions(conv) {
  if (ui.modal) return;
  const pinned = conv.pinOrder != null;
  const pins = pinnedIds();
  const pi = pins.indexOf(conv.id);
  const canDelete = conv.type === 'dm' || conv.myRole === 'admin';
  const item = (ic, label, fn, cls = '') =>
    h('button', { class: `action-item ghost ${cls}`, onclick: () => { closeModal(); fn(); } }, icon(ic), label);
  ui.modal = modal(convTitle(conv),
    h('div', { class: 'action-list' },
      item('pin', pinned ? 'Unpin' : 'Pin to top', () => togglePin(conv)),
      pinned && pi > 0 ? item('up', 'Move up', () => movePin(conv, -1)) : null,
      pinned && pi >= 0 && pi < pins.length - 1 ? item('down', 'Move down', () => movePin(conv, 1)) : null,
      canDelete
        ? item('trash', conv.type === 'dm' ? 'Delete chat (for both)' : 'Delete for everyone', async () => {
          if (!confirm(conv.type === 'dm'
            ? 'Delete this chat and its history for both sides?'
            : `Delete ${convTitle(conv)} for all members?`)) return;
          try {
            await api.deleteConversation(conv.id);
            forgetConv(conv.id);
            await refreshConversations();
          } catch (e) { toast(errMsg(e), true); }
        }, 'danger-text')
        : null,
    ));
  renderMain();
}

function forgetConv(convId) {
  ui.msgs.delete(convId);
  ui.loaded.delete(convId);
  ui.unread.delete(convId);
  ui.drafts.delete(convId);
  lastReadSent.delete(convId);
  if (ui.editing?.convId === convId) ui.editing = null;
  if (ui.activeConvId === convId) ui.activeConvId = null;
}

let dragConvId = null;

function renderSearchOrChats() {
  if (ui.searchResults) {
    return h('div', { class: 'chat-list' },
      ui.searchResults.length === 0 ? h('div', { class: 'muted pad16' }, 'No one found') : null,
      ui.searchResults.map((r) =>
        h('div', {
          class: 'search-hit',
          onclick: async () => {
            ui.searchResults = null;
            ui.searchQuery = '';
            try {
              const conv = await store.startDm(r.ref);
              await refreshConversations();
              openConv(conv.id);
            } catch (e) { toast(errMsg(e), true); renderMain(); }
          },
        },
        avatarFor(r.username, r.kind, false, r.avatarRev ? { ref: r.ref, rev: r.avatarRev } : null),
        h('div', {}, h('div', { class: 'hit-name' }, displayName(r.ref)), h('div', { class: 'muted' }, r.kind)),
        )),
    );
  }
  return h('div', { class: 'chat-list' },
    state.conversations.length === 0
      ? h('div', { class: 'muted pad16' }, 'No chats yet. Search for someone to message, or create a group or channel.')
      : null,
    state.conversations.map((conv) => {
      const peer = dmPeer(conv);
      const online = peer ? state.bundles.get(peer)?.online === true : false;
      const last = ui.msgs.get(conv.id)?.at(-1);
      const unread = ui.unread.get(conv.id) || 0;
      const pinned = conv.pinOrder != null;
      const el = h('div', {
        class: `chat-item${conv.id === ui.activeConvId && ui.view === 'chats' ? ' active' : ''}`,
        onclick: () => openConv(conv.id),
        oncontextmenu: (e) => { e.preventDefault(); openChatActions(conv); },
        ...(pinned ? { draggable: 'true' } : {}),
      },
      avatarFor(convTitle(conv), avatarKind(conv), online, convAv(conv)),
      h('div', { class: 'chat-body' },
        h('div', { class: 'chat-row' },
          h('div', { class: 'chat-name' }, convTitle(conv)),
          pinned ? icon('pin', 'pin-mark') : null,
          last ? h('div', { class: 'chat-time' }, fmtTime(last.ts)) : null),
        h('div', { class: 'chat-row' },
          h('div', { class: 'chat-prev' }, msgPreview(last)),
          unread > 0 ? h('div', { class: 'unread-badge' }, unread > 99 ? '99+' : unread) : null)),
      );
      addLongPress(el, () => openChatActions(conv));
      if (pinned) {
        el.addEventListener('dragstart', () => { dragConvId = conv.id; });
        el.addEventListener('dragover', (e) => { e.preventDefault(); });
        el.addEventListener('drop', (e) => {
          e.preventDefault();
          if (dragConvId == null || dragConvId === conv.id) return;
          const pins = pinnedIds();
          const from = pins.indexOf(dragConvId);
          const to = pins.indexOf(conv.id);
          if (from < 0 || to < 0) return;
          pins.splice(to, 0, pins.splice(from, 1)[0]);
          dragConvId = null;
          savePins(pins);
        });
      }
      return el;
    }),
  );
}

function renderSidebarBottom() {
  return h('div', { class: 'sidebar-bottom' },
    avatarFor(state.me.username, 'user', false,
      state.me.avatarRev ? { ref: state.me.ref, rev: state.me.avatarRev } : null),
    h('div', { class: 'who' }, `@${state.me.username}`),
    h('button', { class: 'icon-btn', title: 'Bots', 'aria-label': 'Bots', onclick: () => { ui.view = 'bots'; ui.activeConvId = null; renderMain(); } }, icon('bot')),
    h('button', { class: 'icon-btn', title: 'Settings', 'aria-label': 'Settings', onclick: () => { ui.view = 'settings'; ui.activeConvId = null; renderMain(); } }, icon('settings')),
    h('button', {
      class: 'icon-btn', title: 'Log out', 'aria-label': 'Log out',
      onclick: async () => {
        await syncPushSubscription(false); // this device stops getting pushes
        await store.logout();
        disconnectWs();
        for (const c of [avatarCache, mediaCache, audioCache]) c.clear();
        lastReadSent.clear();
        render();
      },
    }, icon('logout')),
  );
}

// ---- chat view

function findConv(id) {
  return state.conversations.find((c) => c.id === id);
}

async function openConv(id) {
  ui.view = 'chats';
  ui.activeConvId = id;
  ui.unread.delete(id);
  ui.picker = null;
  ui.select = null;
  clearNotifications(id);
  renderMain();
  const conv = findConv(id);
  if (!conv) return;
  if (!ui.loaded.has(id)) {
    try {
      const { messages } = await api.messages(id);
      for (const m of messages) upsertMessage(id, { ...m, ...(await store.decryptMessage(conv, m)) });
      sortMsgs(id);
      ui.loaded.add(id);
    } catch (e) {
      toast(errMsg(e), true);
    }
  }
  const peer = dmPeer(conv);
  if (peer && !state.bundles.has(peer)) store.getBundle(peer).then(() => renderMain()).catch(() => {});
  markRead(conv);
  renderMain();
  const box = app.querySelector('.messages');
  if (box) box.scrollTop = box.scrollHeight;
}

// -------------------------------------------------------- attachments (UI)

const AUTOLOAD_IMAGE_BYTES = 8 * 1024 * 1024;
const mediaCache = new Map(); // blobId -> { url?, error?, loading? }

function ensureImage(body) {
  let entry = mediaCache.get(body.blobId);
  if (entry) return entry;
  entry = { loading: true };
  mediaCache.set(body.blobId, entry);
  store.fetchFile(body).then((bytes) => {
    entry.url = URL.createObjectURL(new Blob([bytes], { type: body.mime || 'image/png' }));
    entry.loading = false;
    renderMain();
  }).catch((e) => {
    entry.error = errMsg(e);
    entry.loading = false;
    renderMain();
  });
  return entry;
}

async function downloadFile(body, btn) {
  try {
    if (btn) btn.disabled = true;
    const bytes = await store.fetchFile(body);
    const url = URL.createObjectURL(new Blob([bytes], { type: body.mime || 'application/octet-stream' }));
    const a = h('a', { href: url, download: body.name || 'file' });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (e) {
    toast(errMsg(e), true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function openImageViewer(url, name) {
  ui.modal = h('div', {
    class: 'modal-back viewer',
    onclick: () => closeModal(),
  }, h('img', { src: url, alt: name || 'image', draggable: 'false' }));
  renderMain();
}

function updateUploadProgress(localId, progress) {
  for (const list of ui.msgs.values()) {
    const m = list.find((x) => x.localId === localId);
    if (m) { m.uploading = progress; break; }
  }
  const fill = app.querySelector(`[data-mid="${localId}"] .upload-fill`);
  if (fill) fill.style.width = `${Math.round(progress * 100)}%`; // CSSOM, not an inline style attr
  const pct = app.querySelector(`[data-mid="${localId}"] .upload-pct`);
  if (pct) pct.textContent = `${Math.round(progress * 100)}%`;
}

async function imageDims(file) {
  try {
    const bmp = await createImageBitmap(file);
    const d = { w: bmp.width, h: bmp.height };
    bmp.close();
    return d;
  } catch { return null; }
}

async function sendFiles(conv, files, extra = {}) {
  for (const file of files) {
    if (!file) continue;
    if (file.size === 0) { toast(`${file.name || 'file'}: cannot send an empty file`, true); continue; }
    if (file.size > store.MAX_FILE_BYTES) { toast(`${file.name || 'file'}: too large (max 64 MB)`, true); continue; }
    const isImage = (file.type || '').startsWith('image/');
    const dims = isImage ? await imageDims(file) : null;
    const meta = { ...(dims || {}), ...extra };
    const localId = `local-${++localSeq}`;
    upsertMessage(conv.id, {
      localId,
      pending: true,
      uploading: 0,
      senderRef: state.me.ref,
      ts: Date.now(),
      verified: true,
      body: { t: 'file', name: file.name || 'file', size: file.size, mime: file.type || 'application/octet-stream', ...meta },
    });
    renderMain();
    try {
      const sent = await store.sendFile(conv, file, (p) => updateUploadProgress(localId, p), meta);
      if (sent.body.blobId && isImage) {
        mediaCache.set(sent.body.blobId, { url: URL.createObjectURL(file) });
      }
      resolveEcho(conv.id, localId, sent);
    } catch (e) {
      dropEcho(conv.id, localId);
      toast(errMsg(e), true);
    }
    renderMain();
  }
}

// ---- voice messages

const audioCache = new Map(); // blobId -> { loading?, url?, audio?, playing? }

async function toggleVoice(body) {
  let entry = audioCache.get(body.blobId);
  if (entry?.loading) return;
  if (!entry) {
    entry = { loading: true };
    audioCache.set(body.blobId, entry);
    renderMain();
    try {
      const bytes = await store.fetchFile(body);
      entry.url = URL.createObjectURL(new Blob([bytes], { type: body.mime || 'audio/webm' }));
      const audio = new Audio(entry.url);
      entry.audio = audio;
      audio.addEventListener('timeupdate', () => updateVoiceDom(body));
      audio.addEventListener('ended', () => { entry.playing = false; renderMain(); });
    } catch (e) {
      audioCache.delete(body.blobId);
      renderMain();
      return toast(errMsg(e), true);
    }
    entry.loading = false;
  }
  if (!entry.audio) return;
  if (entry.playing) {
    entry.audio.pause();
    entry.playing = false;
  } else {
    for (const [, o] of audioCache) if (o.playing && o.audio) { o.audio.pause(); o.playing = false; }
    entry.playing = true;
    entry.audio.play().catch(() => { entry.playing = false; renderMain(); });
  }
  renderMain();
}

function updateVoiceDom(body) {
  const entry = audioCache.get(body.blobId);
  if (!entry?.audio) return;
  const row = app.querySelector(`[data-vid="${body.blobId}"]`);
  if (!row) return;
  const dur = body.dur || entry.audio.duration || 1;
  const fill = row.querySelector('.voice-fill');
  if (fill) fill.style.width = `${Math.min(100, (entry.audio.currentTime / dur) * 100)}%`;
  const t = row.querySelector('.voice-time');
  if (t) t.textContent = `${fmtDur(entry.audio.currentTime)} / ${fmtDur(dur)}`;
}

function voiceRow(m) {
  const b = m.body;
  const entry = audioCache.get(b.blobId);
  const playing = entry?.playing === true;
  const fill = h('div', { class: 'voice-fill' });
  if (entry?.audio && b.dur) {
    fill.style.width = `${Math.min(100, (entry.audio.currentTime / b.dur) * 100)}%`;
  }
  const track = h('div', {
    class: 'voice-track',
    onclick: (e) => {
      if (!entry?.audio || !b.dur) return;
      const rect = e.currentTarget.getBoundingClientRect();
      entry.audio.currentTime = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)) * b.dur;
      updateVoiceDom(b);
    },
  }, fill);
  return h('div', { class: 'voice-row', 'data-vid': b.blobId },
    h('button', {
      class: 'voice-play', title: playing ? 'Pause' : 'Play',
      'aria-label': playing ? 'Pause voice message' : 'Play voice message',
      onclick: () => toggleVoice(b),
    }, entry?.loading ? h('span', { class: 'voice-spin' }) : icon(playing ? 'pause' : 'play')),
    h('div', { class: 'voice-mid' },
      track,
      h('span', { class: 'voice-time' },
        entry?.audio && playing
          ? `${fmtDur(entry.audio.currentTime)} / ${fmtDur(b.dur || 0)}`
          : fmtDur(b.dur || 0))));
}

async function startRecording(conv) {
  if (rec) return;
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    return toast('voice recording is not supported in this browser', true);
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    return toast('microphone permission denied', true);
  }
  const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
    .find((t) => MediaRecorder.isTypeSupported(t)) || '';
  const recorder = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 64000 } : undefined);
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
  recorder.onstop = () => {
    stream.getTracks().forEach((t) => t.stop());
    const r = rec;
    rec = null;
    if (r) clearInterval(r.interval);
    renderMain();
    if (!r || r.canceled) return;
    const dur = (Date.now() - r.startTs) / 1000;
    if (dur < 0.4 || chunks.length === 0) return toast('recording too short', true);
    const type = recorder.mimeType || mime || 'audio/webm';
    const ext = type.includes('mp4') ? 'm4a' : (type.includes('ogg') ? 'ogg' : 'webm');
    const stamp = new Date().toISOString().slice(0, 19).replaceAll(':', '-');
    const file = new File(chunks, `voice-${stamp}.${ext}`, { type });
    sendFiles(r.conv, [file], { kind: 'voice', dur: Math.round(dur * 10) / 10 });
  };
  rec = {
    conv,
    recorder,
    stream,
    startTs: Date.now(),
    canceled: false,
    interval: setInterval(() => {
      if (!rec) return;
      const el = app.querySelector('.rec-timer');
      if (el) el.textContent = fmtDur((Date.now() - rec.startTs) / 1000);
      if (Date.now() - rec.startTs > 600_000) stopRecording(false); // 10 min cap
    }, 250),
  };
  recorder.start();
  renderMain();
}

function stopRecording(cancel) {
  if (!rec) return;
  rec.canceled = cancel;
  try { rec.recorder.stop(); } catch { /* already stopped */ }
}

function fileBubbleContent(m) {
  const b = m.body;
  const isImage = (b.mime || '').startsWith('image/');
  const isVoice = b.kind === 'voice';

  if (m.pending && m.uploading !== undefined) {
    const pct = Math.round((m.uploading || 0) * 100);
    const fill = h('div', { class: 'upload-fill' });
    fill.style.width = `${pct}%`;
    return h('div', { class: 'file-row' },
      h('div', { class: 'file-icon' }, icon(isVoice ? 'mic' : (isImage ? 'image' : 'file'))),
      h('div', { class: 'file-meta' },
        h('div', { class: 'file-name' }, isVoice ? 'Voice message' : b.name),
        h('div', { class: 'upload-track' }, fill),
        h('div', { class: 'muted' }, h('span', { class: 'upload-pct' }, `${pct}%`), ` of ${fmtSize(b.size)} — encrypting & uploading`)));
  }

  if (isVoice && b.blobId) return voiceRow(m);

  if (isImage && b.blobId) {
    const entry = (b.size <= AUTOLOAD_IMAGE_BYTES || mediaCache.has(b.blobId)) ? ensureImage(b) : null;
    if (!entry) {
      return h('button', { class: 'file-load ghost', onclick: (e) => { ensureImage(b); e.target.disabled = true; } },
        icon('image'), ` Load image (${fmtSize(b.size)})`);
    }
    if (entry.error) return h('div', { class: 'broken-text' }, `⚠ ${entry.error}`);
    if (entry.loading) {
      const ph = h('div', { class: 'img-loading' }, icon('image'), ' decrypting…');
      if (b.w && b.h) { ph.style.aspectRatio = `${b.w} / ${b.h}`; ph.style.width = '320px'; }
      return ph;
    }
    const img = h('img', {
      class: 'img-attach', src: entry.url, alt: b.name, draggable: 'false',
      onclick: () => { if (!ui.select) openImageViewer(entry.url, b.name); },
    });
    if (b.w && b.h) img.style.aspectRatio = `${b.w} / ${b.h}`; // reserve space, no layout jump
    return img;
  }

  const dlBtn = h('button', { class: 'icon-btn dl', title: `Download ${b.name}`, 'aria-label': `Download ${b.name}` }, icon('download'));
  dlBtn.addEventListener('click', () => downloadFile(b, dlBtn));
  return h('div', { class: 'file-row' },
    h('div', { class: 'file-icon' }, icon('file')),
    h('div', { class: 'file-meta' },
      h('div', { class: 'file-name' }, b.name),
      h('div', { class: 'muted' }, fmtSize(b.size))),
    dlBtn);
}

// ---- message actions (edit / delete / copy)

// ---- multi-select (like Telegram: pick messages, then copy/delete)

function canDeleteMsg(conv, m) {
  return m.senderRef === state.me.ref || (conv.myRole === 'admin' && conv.type !== 'dm');
}

function toggleSelect(m) {
  if (!ui.select || m.id == null) return;
  const k = String(m.id);
  if (ui.select.has(k)) ui.select.delete(k);
  else ui.select.add(k);
  if (ui.select.size === 0) ui.select = null;
  renderMain();
}

function selectedMsgs(conv) {
  return (ui.msgs.get(conv.id) || [])
    .filter((m) => m.id != null && ui.select?.has(String(m.id)))
    .sort((a, b) => new Date(a.ts) - new Date(b.ts));
}

function copySelected(conv) {
  const parts = selectedMsgs(conv).map((m) => {
    if (m.error) return null;
    const b = m.body || {};
    if (b.t === 'sticker') return b.emoji;
    if (b.t === 'file') return b.kind === 'voice' ? '[voice message]' : `[${b.name || 'file'}]`;
    return b.text;
  }).filter(Boolean);
  ui.select = null;
  renderMain();
  if (parts.length === 0) return;
  navigator.clipboard?.writeText(parts.join('\n')).then(() => toast('copied')).catch(() => {});
}

async function deleteSelected(conv) {
  const msgs = selectedMsgs(conv);
  if (msgs.length === 0 || !msgs.every((m) => canDeleteMsg(conv, m))) return;
  if (!confirm(`Delete ${msgs.length} message${msgs.length > 1 ? 's' : ''} for everyone?`)) return;
  ui.select = null;
  for (const m of msgs) {
    try {
      await api.deleteMessage(conv.id, m.id);
      const list = convMsgs(conv.id);
      const i = list.findIndex((x) => String(x.id) === String(m.id));
      if (i >= 0) list.splice(i, 1);
    } catch (e) { toast(errMsg(e), true); }
  }
  renderMain();
}

function openMsgActions(conv, m) {
  if (ui.modal || ui.select || m.id == null || m.pending) return;
  const mine = m.senderRef === state.me.ref;
  const canEdit = mine && !m.error && m.body?.t === 'text';
  const canDelete = canDeleteMsg(conv, m);
  const items = [];
  const item = (ic, label, fn, cls = '') =>
    h('button', { class: `action-item ghost ${cls}`, onclick: () => { closeModal(); fn(); } }, icon(ic), label);
  if (!m.error && m.body?.t === 'text') {
    items.push(item('copy', 'Copy text', () =>
      navigator.clipboard?.writeText(m.body.text).then(() => toast('copied')).catch(() => {})));
  }
  items.push(item('check', 'Select', () => {
    ui.select = new Set([String(m.id)]);
    renderMain();
  }));
  if (canEdit) items.push(item('pencil', 'Edit', () => startEdit(conv, m)));
  if (canDelete) {
    items.push(item('trash', 'Delete for everyone', async () => {
      if (!confirm('Delete this message for everyone?')) return;
      try {
        await api.deleteMessage(conv.id, m.id);
        const list = convMsgs(conv.id);
        const i = list.findIndex((x) => String(x.id) === String(m.id));
        if (i >= 0) list.splice(i, 1);
        renderMain();
      } catch (e) { toast(errMsg(e), true); }
    }, 'danger-text'));
  }
  if (items.length === 0) return;
  ui.modal = modal('Message', h('div', { class: 'action-list' }, items));
  renderMain();
}

function startEdit(conv, m) {
  ui.editing = { convId: conv.id, id: m.id, prevDraft: ui.drafts.get(conv.id) || '' };
  ui.drafts.set(conv.id, m.body.text);
  ui.picker = null;
  renderMain();
  const input = app.querySelector('[data-fid="composer"]');
  if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
}

function cancelEdit(conv) {
  if (!ui.editing) return;
  ui.drafts.set(conv.id, ui.editing.prevDraft || '');
  ui.editing = null;
  renderMain();
}

// ---- emoji & stickers

const EMOJI = {
  Smileys: '😀 😃 😄 😁 😆 😅 😂 🤣 😊 😇 🙂 🙃 😉 😌 😍 🥰 😘 😗 😙 😚 😋 😛 😝 😜 🤪 🤨 🧐 🤓 😎 🥸 🤩 🥳 😏 😒 😞 😔 😟 😕 🙁 😣 😖 😫 😩 🥺 😢 😭 😤 😠 😡 🤬 🤯 😳 🥵 🥶 😱 😨 😰 😥 😓 🤗 🤔 🤭 🤫 🤥 😶 😐 😑 😬 🙄 😯 😦 😧 😮 😲 🥱 😴 🤤 😪 😵 🤐 🥴 🤢 🤮 🤧 😷 🤒 🤕 🤑 🤠 😈 👿 🤡 💩 👻 💀 👽 👾 🤖 🎃 😺 😸 😹 😻 😼 😽 🙀 😿 😾'.split(' '),
  Gestures: '👋 🤚 🖐 ✋ 🖖 👌 🤌 🤏 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 🖕 👇 ☝️ 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 👐 🤲 🤝 🙏 ✍️ 💅 🤳 💪 🦾 🦵 🦶 👂 👃 🧠 🦷 👀 👁 👅 👄'.split(' '),
  Hearts: '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 💋 💯 💢 💥 💫 💦 💨 💬 💭 💤'.split(' '),
  Animals: '🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🙈 🙉 🙊 🐒 🐔 🐧 🐦 🐤 🦆 🦅 🦉 🦇 🐺 🐗 🐴 🦄 🐝 🐛 🦋 🐌 🐞 🐜 🦂 🐢 🐍 🦎 🦖 🦕 🐙 🦑 🦐 🦞 🦀 🐡 🐠 🐟 🐬 🐳 🐋 🦈 🐊 🐅 🐆 🦓 🦍 🐘 🦛 🦏 🐪 🐫 🦒 🦘 🐃 🐂 🐄 🐎 🐖 🐏 🐑 🦙 🐐 🦌 🐕 🐩 🐈 🐓 🦃 🦚 🦜 🦢 🦩 🕊 🐇 🦝 🦨 🦡 🦦 🦥 🐿 🦔'.split(' '),
  Food: '🍏 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🫐 🍈 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🍆 🥑 🥦 🥒 🌶 🌽 🥕 🥔 🍠 🥐 🍞 🥖 🥨 🧀 🥚 🍳 🥞 🧇 🥓 🥩 🍗 🍖 🌭 🍔 🍟 🍕 🥪 🌮 🌯 🥗 🍝 🍜 🍲 🍛 🍣 🍱 🥟 🍤 🍙 🍚 🍘 🥠 🍢 🍡 🍧 🍨 🍦 🥧 🧁 🍰 🎂 🍮 🍭 🍬 🍫 🍿 🍩 🍪 🌰 🥜 ☕ 🍵 🧃 🥤 🧋 🍶 🍺 🍻 🥂 🍷 🥃 🍸 🍹 🍾'.split(' '),
  Activity: '⚽ 🏀 🏈 ⚾ 🎾 🏐 🏉 🎱 🏓 🏸 🏒 🥅 ⛳ 🏹 🎣 🥊 🥋 ⛸ 🎿 🏂 🏋️ 🤸 🤺 ⛹️ 🏌️ 🏇 🧘 🏄 🏊 🚣 🧗 🚵 🚴 🏆 🥇 🥈 🥉 🏅 🎖 🎫 🎪 🤹 🎭 🎨 🎬 🎤 🎧 🎼 🎹 🥁 🎷 🎺 🎸 🎻 🎲 ♟ 🎯 🎳 🎮 🎰 🧩'.split(' '),
  Objects: '⌚ 📱 💻 ⌨️ 🖥 🖨 🖱 💾 💿 📷 📸 📹 🎥 📞 ☎️ 📺 📻 🧭 ⏰ ⌛ 📡 🔋 🔌 💡 🔦 🕯 💸 💵 💰 💳 💎 ⚖️ 🧰 🔧 🔨 ⚙️ 🧲 🔫 💣 🔪 🛡 🚬 ⚰️ 🔮 💈 🔭 🔬 💊 💉 🧬 🦠 🧪 🌡 🧹 🧺 🚽 🚿 🛁 🧼 🪥 🧽 🛎 🔑 🚪 🪑 🛏 🧸 🖼 🛍 🛒 🎁 🎈 🎀 🎊 🎉 🏮 ✉️ 📦 📜 📄 📊 📈 📉 📅 📋 📁 📰 📚 📖 🔖 🔗 📎 📐 📏 📌 📍 ✂️ 🖊 ✏️ 🔍 🔒 🔓'.split(' '),
  Symbols: '✅ ❌ ❓ ❗ ⭐ 🌟 ✨ ⚡ 🔥 🌈 ☀️ ⛅ 🌧 ⛈ ❄️ ⛄ 💧 🌊 ☔ ⚠️ 🚫 ♻️ 💤 🆗 🆒 🆕 🆓 🆙 🎵 🎶 ➕ ➖ ➗ ✖️ 💲 ✔️ ☑️ 🔴 🟠 🟡 🟢 🔵 🟣 ⚫ ⚪ 🟤 🔺 🔻 🔸 🔹 🔶 🔷 🟥 🟧 🟨 🟩 🟦 🟪 ⬛ ⬜ 🔈 🔊 🔔 🔕 📣 📢 🏁 🚩'.split(' '),
};

const STICKERS = ('😂 🤣 😍 🥰 😎 🤩 🥳 😜 🤪 😇 😉 😊 🙃 😏 🤤 😴 🥱 🤯 😱 😭 🥺 😢 😡 🤬 🤔 🧐 🙄 😬 🤫 🤭 '
  + '👍 👎 👏 🙏 💪 🤝 ✌️ 🤟 🤘 👌 👀 💋 🔥 ❤️ 💔 💯 ✨ 🎉 🎂 🌹 🌈 ☀️ ⚡ ⭐ 🍕 🍺 ☕ ⚽ 🚀 🐱 🐶 🦄 🙈 💩 🤖 👻 🎃').split(' ');

function insertEmojiIntoComposer(emoji) {
  const input = app.querySelector('[data-fid="composer"]');
  if (!input) return;
  const s = input.selectionStart ?? input.value.length;
  const e = input.selectionEnd ?? s;
  input.value = input.value.slice(0, s) + emoji + input.value.slice(e);
  const pos = s + emoji.length;
  input.setSelectionRange(pos, pos);
  input.dispatchEvent(new Event('input')); // updates draft + send button
  input.focus();
}

let pickerCache = null; // { tab, el } — heavy DOM, rebuilt only when the tab changes

function buildPicker() {
  const tabBtn = (tab, label) => h('button', {
    class: `picker-tab${ui.picker === tab ? ' active' : ''}`,
    onclick: () => { ui.picker = tab; pickerCache = null; renderMain(); },
  }, label);
  const head = h('div', { class: 'picker-tabs' }, tabBtn('emoji', 'Emoji'), tabBtn('stickers', 'Stickers'),
    h('div', { class: 'spacer' }),
    h('button', { class: 'icon-btn', title: 'Close', 'aria-label': 'Close picker', onclick: () => { ui.picker = null; renderMain(); } }, icon('x')));
  let body;
  if (ui.picker === 'stickers') {
    body = h('div', { class: 'picker-body' },
      h('div', { class: 'sticker-grid' },
        STICKERS.map((st) => h('button', {
          class: 'sticker-cell',
          onclick: () => {
            const conv = findConv(ui.activeConvId);
            if (conv) sendStickerFlow(conv, st);
          },
        }, st))));
  } else {
    body = h('div', { class: 'picker-body' },
      Object.entries(EMOJI).map(([cat, list]) => [
        h('div', { class: 'picker-cat' }, cat),
        h('div', { class: 'emoji-grid' },
          list.map((em) => h('button', {
            class: 'emoji-cell',
            onclick: () => insertEmojiIntoComposer(em),
          }, em))),
      ]));
  }
  return h('div', { class: 'picker' }, head, body);
}

function renderPicker() {
  if (!ui.picker) { pickerCache = null; return null; }
  if (!pickerCache || pickerCache.tab !== ui.picker) {
    pickerCache = { tab: ui.picker, el: buildPicker() };
  }
  return pickerCache.el;
}

async function sendStickerFlow(conv, emoji) {
  ui.picker = null;
  const localId = `local-${++localSeq}`;
  upsertMessage(conv.id, {
    localId, pending: true, senderRef: state.me.ref, ts: Date.now(),
    body: { t: 'sticker', emoji }, verified: true,
  });
  renderMain();
  try {
    const sent = await store.sendSticker(conv, emoji);
    resolveEcho(conv.id, localId, sent);
  } catch (e) {
    dropEcho(conv.id, localId);
    toast(errMsg(e), true);
  }
  renderMain();
}

// ---- messages

function buildMessagesBox(conv) {
  const msgs = ui.msgs.get(conv.id) || [];
  const otherRead = maxOtherRead(conv);
  const selecting = ui.select != null;
  const rows = [];
  let lastDay = null;
  for (const m of msgs) {
    const day = new Date(m.ts).toDateString();
    if (day !== lastDay) {
      rows.push(h('div', { class: 'day-sep' }, h('span', {}, fmtDay(m.ts))));
      lastDay = day;
    }
    const mine = m.senderRef === state.me.ref;
    const isSticker = !m.error && m.body?.t === 'sticker';
    const isBigEmoji = !m.error && m.body?.t === 'text' && emojiOnly(m.body.text);
    const isMedia = !m.error && m.body?.t === 'file' && (m.body.mime || '').startsWith('image/')
      && m.body.kind !== 'voice' && !m.uploading && !m.pending;
    const read = mine && !m.pending && m.id != null && Number(m.id) <= otherRead;
    const selected = selecting && m.id != null && ui.select.has(String(m.id));

    const stamp = h('span', { class: 'stamp' },
      !m.error && !m.pending && m.verified === false
        ? h('span', { class: 'unverified', title: 'signature could not be verified' }, '⚠ unverified')
        : null,
      m.editedAt ? h('span', { class: 'edited' }, 'edited') : null,
      h('span', { class: 'time' }, fmtTime(m.ts)),
      mine ? h('span', { class: `tick${read ? ' read' : ''}`, title: m.pending ? 'sending' : (read ? 'read' : 'sent') },
        icon(m.pending ? 'clock' : (read ? 'checks' : 'check'))) : null);

    let content;
    if (m.error) content = h('span', { class: 'text' }, `⚠ ${m.error}`);
    else if (isSticker) content = h('div', { class: 'sticker-emoji' }, m.body.emoji || '');
    else if (m.body?.t === 'file') content = fileBubbleContent(m);
    else content = h('span', { class: 'text' }, linkify(m.body?.text ?? ''));

    const bubble = h('div', {
      class: `bubble${m.error ? ' broken' : ''}${isMedia ? ' media' : ''}${isSticker ? ' sticker-bubble' : ''}${isBigEmoji ? ' big-emoji' : ''}`,
    }, content, stamp);

    const msgEl = h('div', {
      class: `msg${mine ? ' out' : ''}${selecting ? ' selecting' : ''}${selected ? ' sel' : ''}`,
      'data-mid': m.localId || m.id,
    },
    conv.type !== 'dm' && !mine
      ? h('div', { class: 'meta' },
        h('span', { class: 'sender', onclick: () => openProfileModal(m.senderRef) }, displayName(m.senderRef)))
      : null,
    bubble,
    !selecting && m.id != null && !m.pending
      ? h('button', {
        class: 'msg-menu icon-btn', title: 'Message actions', 'aria-label': 'Message actions',
        onclick: (e) => { e.stopPropagation(); openMsgActions(conv, m); },
      }, icon('more'))
      : null,
    selecting && m.id != null
      ? h('div', { class: 'sel-overlay', onclick: () => toggleSelect(m) },
        h('span', { class: `sel-dot${selected ? ' on' : ''}` }, selected ? icon('check') : null))
      : null,
    );
    if (!selecting) {
      bubble.addEventListener('contextmenu', (e) => { e.preventDefault(); openMsgActions(conv, m); });
      addLongPress(bubble, () => openMsgActions(conv, m));
    }
    rows.push(msgEl);
  }

  const box = h('div', { class: 'messages', 'data-conv': String(conv.id) },
    msgs.length === 0
      ? h('div', { class: 'day-sep' }, h('span', {}, 'No messages yet — everything you send is end-to-end encrypted'))
      : null,
    rows);
  // Nothing inside the chat may start a drag: selected text or an image
  // being dragged used to hit the (now removed) drop zone and re-send.
  box.addEventListener('dragstart', (e) => e.preventDefault());
  return box;
}

function renderChat() {
  const conv = findConv(ui.activeConvId);
  if (!conv) return [h('div', { class: 'empty-state' }, 'This chat no longer exists')];
  const peer = dmPeer(conv);
  const peerInfo = peer ? state.bundles.get(peer) : null;
  const canPost = conv.type !== 'channel' || conv.myRole === 'admin';

  const sub = conv.type === 'dm'
    ? (peer?.startsWith('b:') ? 'bot' : (peerInfo?.online === true ? 'online' : (peerInfo?.online === false ? 'offline' : '')))
    : `${conv.type} · ${conv.members.length} member${conv.members.length > 1 ? 's' : ''}`;

  if (ui.select) {
    const sel = selectedMsgs(conv);
    const deletable = sel.length > 0 && sel.every((m) => canDeleteMsg(conv, m));
    const copyBtn = h('button', {
      class: 'icon-btn', title: 'Copy selected', 'aria-label': 'Copy selected',
      onclick: () => copySelected(conv),
    }, icon('copy'));
    const delBtn = deletable
      ? h('button', {
        class: 'icon-btn danger-ic', title: 'Delete selected', 'aria-label': 'Delete selected',
        onclick: () => deleteSelected(conv),
      }, icon('trash'))
      : null;
    const selectHeader = h('div', { class: 'chat-header select-bar' },
      h('button', {
        class: 'icon-btn', title: 'Cancel selection', 'aria-label': 'Cancel selection',
        onclick: () => { ui.select = null; renderMain(); },
      }, icon('x')),
      h('div', { class: 'title' }, `${ui.select.size} selected`),
      h('div', { class: 'spacer' }),
      copyBtn, delBtn);
    return [selectHeader, buildMessagesBox(conv), h('div', { class: 'readonly-note' },
      'Tap messages to select · copy or delete them together')];
  }

  const header = h('div', { class: 'chat-header' },
    h('button', {
      class: 'icon-btn back-btn', title: 'Back', 'aria-label': 'Back',
      onclick: () => { ui.activeConvId = null; renderMain(); },
    }, icon('back')),
    avatarFor(convTitle(conv), avatarKind(conv), peerInfo?.online === true, convAv(conv)),
    h('div', {
      class: 'chat-head-text',
      onclick: () => (conv.type === 'dm' ? openProfileModal(peer) : openInfoModal(conv)),
    },
      h('div', { class: 'title' }, convTitle(conv)),
      sub ? h('div', { class: `muted${peerInfo?.online === true ? ' online-text' : ''}` }, sub) : null),
    h('div', { class: 'spacer' }),
    h('button', {
      class: 'icon-btn',
      title: conv.type === 'dm' ? 'verify encryption' : 'conversation info',
      'aria-label': conv.type === 'dm' ? 'verify' : 'info',
      onclick: () => openInfoModal(conv),
    }, icon(conv.type === 'dm' ? 'shield' : 'info')),
  );

  const box = buildMessagesBox(conv);

  let bottom;
  if (rec && rec.conv.id === conv.id) {
    bottom = h('div', { class: 'composer recording' },
      h('button', {
        class: 'icon-btn rec-cancel', title: 'Cancel recording', 'aria-label': 'Cancel recording',
        onclick: () => stopRecording(true),
      }, icon('trash')),
      h('span', { class: 'rec-dot' }),
      h('span', { class: 'rec-timer' }, fmtDur((Date.now() - rec.startTs) / 1000)),
      h('div', { class: 'spacer' }),
      h('div', { class: 'muted rec-hint' }, 'recording voice message'),
      h('button', {
        class: 'send-btn has-text', title: 'Send voice message', 'aria-label': 'Send voice message',
        onclick: () => stopRecording(false),
      }, icon('send')));
  } else if (canPost) {
    const editingThis = ui.editing?.convId === conv.id;
    const fileInput = h('input', {
      type: 'file', class: 'hidden-file', multiple: '',
      onchange: (e) => {
        const files = [...e.target.files];
        e.target.value = '';
        if (files.length) sendFiles(conv, files);
      },
    });
    const input = h('input', {
      class: 'composer-input',
      'data-fid': 'composer',
      placeholder: editingThis ? 'Edit message' : 'Message',
      maxlength: '4096',
      autocomplete: 'off',
      value: ui.drafts.get(conv.id) || '',
      oninput: (e) => { ui.drafts.set(conv.id, e.target.value); syncSend(); },
      onpaste: (e) => {
        const files = [...(e.clipboardData?.files || [])];
        if (files.length) { e.preventDefault(); sendFiles(conv, files); }
      },
    });
    const send = async () => {
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      ui.drafts.delete(conv.id);

      if (editingThis) {
        const ed = ui.editing;
        ui.editing = null;
        try {
          const res = await store.editText(conv, ed.id, text);
          const list = convMsgs(conv.id);
          const msg = list.find((x) => String(x.id) === String(ed.id));
          if (msg) { msg.body = { t: 'text', text }; msg.editedAt = res.editedAt; msg.verified = true; }
          if (ed.prevDraft) ui.drafts.set(conv.id, ed.prevDraft);
        } catch (e) { toast(errMsg(e), true); }
        renderMain();
        return;
      }

      const localId = `local-${++localSeq}`;
      upsertMessage(conv.id, {
        localId, pending: true, senderRef: state.me.ref, ts: Date.now(),
        body: { t: 'text', text }, verified: true,
      });
      renderMain();
      try {
        const sent = await store.sendText(conv, text);
        resolveEcho(conv.id, localId, sent);
      } catch (e) {
        dropEcho(conv.id, localId);
        ui.drafts.set(conv.id, text); // give the draft back
        toast(errMsg(e), true);
      }
      renderMain();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') send();
      else if (e.key === 'Escape') {
        if (editingThis) cancelEdit(conv);
        else if (ui.picker) { ui.picker = null; renderMain(); }
      }
    });
    const sendBtn = h('button', { class: 'send-btn', title: 'Send', 'aria-label': 'Send', onclick: send }, icon('send'));
    const micBtn = h('button', {
      class: 'icon-btn mic-btn', title: 'Record a voice message', 'aria-label': 'Record a voice message',
      onclick: () => startRecording(conv),
    }, icon('mic'));
    const syncSend = () => {
      const has = input.value.trim().length > 0;
      sendBtn.classList.toggle('has-text', has || editingThis);
      sendBtn.hidden = !has && !editingThis;
      micBtn.hidden = has || editingThis;
    };
    syncSend();

    const editBar = editingThis
      ? h('div', { class: 'edit-bar' },
        icon('pencil', 'edit-ic'),
        h('div', { class: 'edit-info' },
          h('div', { class: 'edit-title' }, 'Editing message'),
          h('div', { class: 'muted ellip' },
            (ui.msgs.get(conv.id) || []).find((x) => String(x.id) === String(ui.editing.id))?.body?.text || '')),
        h('button', { class: 'icon-btn', title: 'Cancel editing', 'aria-label': 'Cancel editing', onclick: () => cancelEdit(conv) }, icon('x')))
      : null;

    bottom = h('div', { class: 'composer-wrap' },
      renderPicker(),
      editBar,
      h('div', { class: 'composer' },
        fileInput,
        h('button', {
          class: `icon-btn${ui.picker ? ' active-ic' : ''}`, title: 'Emoji & stickers', 'aria-label': 'Emoji and stickers',
          onclick: () => { ui.picker = ui.picker ? null : 'emoji'; renderMain(); },
        }, icon('smile')),
        h('button', {
          class: 'icon-btn', title: 'Attach a file (up to 64 MB)', 'aria-label': 'Attach a file',
          onclick: () => fileInput.click(),
        }, icon('paperclip')),
        input, micBtn, sendBtn));
  } else {
    bottom = h('div', { class: 'readonly-note' }, icon('radio'), ' Only admins can post in this channel');
  }
  return [header, box, bottom];
}

// ---- modals

function closeModal() {
  ui.modal = null;
  renderMain();
}

function modal(title, ...content) {
  return h('div', { class: 'modal-back', onclick: (e) => { if (e.target.classList.contains('modal-back')) closeModal(); } },
    h('div', { class: 'modal' },
      h('div', { class: 'modal-head' },
        h('h3', {}, title),
        h('button', { class: 'icon-btn', title: 'Close', 'aria-label': 'Close', onclick: closeModal }, icon('x'))),
      ...content));
}

function openCreateRoomModal() {
  const name = h('input', { placeholder: 'Name', maxlength: '64', 'data-fid': 'room-name' });
  const type = h('select', {},
    h('option', { value: 'group' }, 'Group — everyone can post'),
    h('option', { value: 'channel' }, 'Channel — only admins post'));
  const err = h('div', { class: 'error-text' });
  ui.modal = modal('New group or channel',
    h('div', { class: 'field' }, h('label', {}, 'Type'), type),
    h('div', { class: 'field' }, h('label', {}, 'Name'), name),
    err,
    h('div', { class: 'actions' },
      h('button', { class: 'ghost', onclick: closeModal }, 'Cancel'),
      h('button', {
        class: 'primary',
        onclick: async () => {
          try {
            const conv = await store.createRoom(type.value, name.value.trim());
            await refreshConversations();
            closeModal();
            openConv(conv.id);
          } catch (e) { err.textContent = errMsg(e); }
        },
      }, 'Create')));
  renderMain();
  name.focus();
}

function openInfoModal(conv) {
  const isAdmin = conv.myRole === 'admin';
  const canInvite = conv.type === 'group' ? true : isAdmin;

  if (conv.type === 'dm') {
    const peer = dmPeer(conv);
    store.getBundle(peer).then((b) => openFingerprintModal(peer, b)).catch((e) => toast(errMsg(e), true));
    return;
  }

  const rows = conv.members.map((m) => h('div', { class: 'member-row' },
    h('div', {
      class: 'member-id',
      onclick: () => openProfileModal(m.ref),
    },
    avatarFor(m.ref.slice(2), m.ref.startsWith('b:') ? 'bot' : 'user', false,
      m.avatarRev ? { ref: m.ref, rev: m.avatarRev } : null),
    h('div', { class: 'name' }, displayName(m.ref), ' ', m.role === 'admin' ? h('span', { class: 'badge' }, 'admin') : null)),
    h('button', {
      class: 'icon-btn', title: `verify ${displayName(m.ref)}`, 'aria-label': `verify ${displayName(m.ref)}`,
      onclick: async () => {
        try {
          const b = await store.getBundle(m.ref);
          openFingerprintModal(m.ref, b);
        } catch (e) { toast(errMsg(e), true); }
      },
    }, icon('shield')),
    isAdmin && m.ref !== state.me.ref
      ? h('button', {
        class: 'danger small',
        onclick: async () => {
          if (!confirm(`Remove ${displayName(m.ref)} and rotate the key?`)) return;
          try {
            await store.removeMemberAndRotate(conv, m.ref);
            await refreshConversations();
            toast('member removed, key rotated');
            closeModal();
          } catch (e) { toast(errMsg(e), true); }
        },
      }, 'remove')
      : null,
  ));

  const roomAvInput = h('input', {
    type: 'file', class: 'hidden-file', accept: 'image/*',
    onchange: (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      openCropModal(file, 'Room photo', async (blob) => {
        try {
          await api.uploadConvAvatar(conv.id, blob);
          toast('room photo updated');
          await refreshConversations();
        } catch (err) { toast(errMsg(err), true); }
      });
    },
  });

  ui.modal = modal(convTitle(conv),
    h('div', { class: 'profile-view' },
      h('div', { class: 'avatar-big' }, avatarFor(convTitle(conv), conv.type, false, convAv(conv))),
      isAdmin
        ? h('div', { class: 'row wrap-row center-row' },
          roomAvInput,
          h('button', { class: 'ghost small', onclick: () => roomAvInput.click() },
            icon('camera'), conv.avatarRev ? ' Change photo' : ' Set photo'),
          conv.avatarRev
            ? h('button', {
              class: 'danger small',
              onclick: async () => {
                try {
                  await api.deleteConvAvatar(conv.id);
                  toast('room photo removed');
                  await refreshConversations();
                  closeModal();
                } catch (err) { toast(errMsg(err), true); }
              },
            }, 'Remove')
            : null)
        : null),
    h('div', { class: 'muted mb10' },
      `${conv.type} · key v${conv.keyVersion}, wrapped per-member with X-Wing (X25519+ML-KEM-768)`),
    ...rows,
    h('div', { class: 'actions wrap' },
      canInvite ? h('button', { class: 'ghost', onclick: () => openInviteModal(conv) }, icon('plus'), ' Add member') : null,
      isAdmin ? h('button', {
        class: 'ghost',
        title: 'Generate a new conversation key and re-wrap it for all members',
        onclick: async () => {
          try {
            const v = await store.rotateKey(conv);
            await refreshConversations();
            toast(`key rotated to v${v}`);
            closeModal();
          } catch (e) { toast(errMsg(e), true); }
        },
      }, icon('rotate'), ' Rotate key') : null,
      h('button', {
        class: 'danger',
        onclick: async () => {
          if (!confirm('Leave this conversation?')) return;
          try {
            await api.removeMember(conv.id, state.me.ref);
            ui.activeConvId = null;
            await refreshConversations();
            closeModal();
          } catch (e) { toast(errMsg(e), true); }
        },
      }, 'Leave')));
  renderMain();
}

function openFingerprintModal(ref, bundleEntry) {
  ui.modal = modal(`Verify ${displayName(ref)}`,
    bundleEntry.keys === null
      ? h('div', { class: 'error-text' }, '⚠ This identity FAILED signature verification. Do not trust it.')
      : h('div', { class: 'muted mb10' },
          'Compare these fingerprints over a trusted channel (in person, a call). If they match, your encryption cannot be intercepted — not even by the server.'),
    h('div', { class: 'field' }, h('label', {}, `${displayName(ref)}'s fingerprint`),
      h('div', { class: 'fp' }, store.fingerprintOf(ref) || '—')),
    h('div', { class: 'field' }, h('label', {}, 'Your fingerprint'),
      h('div', { class: 'fp' }, store.myFingerprint())),
    h('div', { class: 'actions' }, h('button', { class: 'primary', onclick: closeModal }, 'Done')));
  renderMain();
}

function openInviteModal(conv) {
  const input = h('input', { placeholder: 'Search users and bots…', 'data-fid': 'invite-search' });
  const results = h('div', {});
  const err = h('div', { class: 'error-text' });
  input.addEventListener('input', async () => {
    const qq = input.value.trim();
    if (qq.length < 2) return results.replaceChildren();
    try {
      const { results: found } = await api.search(qq);
      results.replaceChildren(...found
        .filter((r) => !conv.members.some((m) => m.ref === r.ref))
        .map((r) => h('div', { class: 'member-row' },
          avatarFor(r.username, r.kind, false, r.avatarRev ? { ref: r.ref, rev: r.avatarRev } : null),
          h('div', { class: 'name' }, displayName(r.ref)),
          h('button', {
            class: 'small primary',
            onclick: async () => {
              err.textContent = '';
              try {
                await store.invite(conv, r.ref);
                await refreshConversations();
                toast(`${r.username} added — conversation keys shared`);
                closeModal();
              } catch (e) { err.textContent = errMsg(e); }
            },
          }, 'add'))));
    } catch { /* transient */ }
  });
  ui.modal = modal(`Add member to ${convTitle(conv)}`,
    h('div', { class: 'muted mb8' },
      'Adding someone wraps the conversation keys to their verified public keys so they can read the history.'),
    input, results, err,
    h('div', { class: 'actions' }, h('button', { class: 'ghost', onclick: closeModal }, 'Cancel')));
  renderMain();
  input.focus();
}

// ---- settings view

function viewHeader(title) {
  return h('div', { class: 'view-head' },
    h('button', {
      class: 'icon-btn', title: 'Back', 'aria-label': 'back',
      onclick: () => { ui.view = 'chats'; renderMain(); },
    }, icon('back')),
    h('h2', {}, title));
}

// Decode an image file; createImageBitmap first, <img> fallback for formats
// it refuses (e.g. exotic PNG flavors).
async function decodeImage(file) {
  try {
    const bmp = await createImageBitmap(file);
    return { src: bmp, w: bmp.width, h: bmp.height, close: () => bmp.close() };
  } catch {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error('could not decode image'));
        img.src = url;
      });
      return { src: img, w: img.naturalWidth, h: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
    } catch (e) {
      URL.revokeObjectURL(url);
      throw e;
    }
  }
}

// Interactive crop: drag to position, wheel/slider to zoom, then export a
// centered 256x256 JPEG.
async function openCropModal(file, title, onDone) {
  let im;
  try {
    im = await decodeImage(file);
  } catch (e) { return toast(errMsg(e), true); }
  const V = Math.min(300, Math.floor(window.innerWidth * 0.78));
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const canvas = h('canvas', { class: 'crop-canvas' });
  canvas.width = V * dpr;
  canvas.height = V * dpr;
  canvas.style.width = `${V}px`;
  canvas.style.height = `${V}px`;
  const ctx = canvas.getContext('2d');
  const k0 = Math.max(V / im.w, V / im.h); // cover
  let zoom = 1;
  let offX = (V - im.w * k0) / 2;
  let offY = (V - im.h * k0) / 2;
  const draw = () => {
    const k = k0 * zoom;
    offX = Math.min(0, Math.max(V - im.w * k, offX));
    offY = Math.min(0, Math.max(V - im.h * k, offY));
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, V, V);
    ctx.drawImage(im.src, offX, offY, im.w * k, im.h * k);
    ctx.restore();
  };
  draw();

  let drag = null;
  canvas.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    offX += e.clientX - drag.x;
    offY += e.clientY - drag.y;
    drag = { x: e.clientX, y: e.clientY };
    draw();
  });
  canvas.addEventListener('pointerup', () => { drag = null; });
  canvas.addEventListener('pointercancel', () => { drag = null; });

  const slider = h('input', {
    type: 'range', min: '1', max: '4', step: '0.01', value: '1', class: 'crop-zoom',
    'aria-label': 'Zoom',
    oninput: (e) => zoomTo(Number(e.target.value)),
  });
  const zoomTo = (z, cx = V / 2, cy = V / 2) => {
    const kOld = k0 * zoom;
    zoom = Math.min(4, Math.max(1, z));
    const kNew = k0 * zoom;
    offX = cx - ((cx - offX) / kOld) * kNew;
    offY = cy - ((cy - offY) / kOld) * kNew;
    slider.value = String(zoom);
    draw();
  };
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    zoomTo(zoom * (e.deltaY < 0 ? 1.12 : 0.9), e.clientX - rect.left, e.clientY - rect.top);
  }, { passive: false });

  ui.modal = modal(title,
    h('div', { class: 'crop-wrap' }, canvas),
    h('div', { class: 'crop-controls' }, icon('image'), slider),
    h('div', { class: 'muted center mb8' }, 'Drag to position · scroll or slide to zoom'),
    h('div', { class: 'actions' },
      h('button', { class: 'ghost', onclick: () => { im.close(); closeModal(); } }, 'Cancel'),
      h('button', {
        class: 'primary',
        onclick: () => {
          const out = document.createElement('canvas');
          out.width = 256;
          out.height = 256;
          const r = 256 / V;
          const k = k0 * zoom;
          out.getContext('2d').drawImage(im.src, offX * r, offY * r, im.w * k * r, im.h * k * r);
          im.close();
          closeModal();
          out.toBlob((b) => {
            if (b) onDone(b);
            else toast('could not encode image', true);
          }, 'image/jpeg', 0.85);
        },
      }, 'Save')));
  renderMain();
}

// ---- user profile

async function openProfileModal(ref) {
  try {
    const b = await store.getBundle(ref, { refresh: true });
    const av = b.avatarRev ? { ref, rev: b.avatarRev } : null;
    ui.modal = modal(`@${ref.slice(2)}`,
      h('div', { class: 'profile-view' },
        h('div', { class: 'avatar-big' }, avatarFor(ref.slice(2), b.kind, false, av)),
        h('div', { class: 'profile-name' }, displayName(ref)),
        h('div', { class: `muted${b.online === true ? ' online-text' : ''}` },
          b.kind === 'bot' ? 'bot' : (b.online === true ? 'online' : (b.online === false ? 'offline' : '')))),
      b.keys === null
        ? h('div', { class: 'error-text' }, '⚠ This identity FAILED signature verification. Do not trust it.')
        : null,
      h('div', { class: 'field' }, h('label', {}, 'Encryption fingerprint'),
        h('div', { class: 'fp' }, store.fingerprintOf(ref) || '—')),
      h('div', { class: 'muted mb8' },
        'Compare fingerprints over a trusted channel (in person, a call) to verify the end-to-end encryption.'),
      h('div', { class: 'actions' },
        ref !== state.me.ref
          ? h('button', {
            class: 'primary',
            onclick: async () => {
              try {
                const conv = await store.startDm(ref);
                await refreshConversations();
                closeModal();
                openConv(conv.id);
              } catch (e) { toast(errMsg(e), true); }
            },
          }, icon('send'), ' Message')
          : null,
        h('button', { class: 'ghost', onclick: closeModal }, 'Close')));
    renderMain();
  } catch (e) { toast(errMsg(e), true); }
}

function renderProfileCard() {
  const fileInput = h('input', {
    type: 'file', class: 'hidden-file', accept: 'image/*',
    onchange: (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      openCropModal(file, 'Adjust your avatar', async (blob) => {
        try {
          const res = await api.uploadAvatar(blob);
          state.me.avatarRev = res.avatarRev;
          toast('avatar updated');
          refreshConversations();
        } catch (err) { toast(errMsg(err), true); }
      });
    },
  });
  return h('div', { class: 'card' },
    h('h3', {}, 'Profile'),
    h('div', { class: 'row profile-row' },
      h('div', { class: 'avatar-big' },
        avatarFor(state.me.username, 'user', false,
          state.me.avatarRev ? { ref: state.me.ref, rev: state.me.avatarRev } : null)),
      h('div', { class: 'profile-info' },
        h('div', { class: 'profile-name' }, `@${state.me.username}`),
        h('div', { class: 'muted' }, 'Your avatar is visible to other users. It is profile data, not an encrypted message.'),
        h('div', { class: 'row wrap-row' },
          fileInput,
          h('button', { class: 'ghost', onclick: () => fileInput.click() },
            icon('camera'), state.me.avatarRev ? ' Change avatar' : ' Set avatar'),
          state.me.avatarRev
            ? h('button', {
              class: 'danger small',
              onclick: async () => {
                try {
                  await api.deleteAvatar();
                  state.me.avatarRev = 0;
                  toast('avatar removed');
                  refreshConversations();
                } catch (err) { toast(errMsg(err), true); }
              },
            }, 'Remove')
            : null))));
}

function renderSettings() {
  const s = state.me.settings;
  const sel = (key, label, hint) => {
    const el = h('select', {
      onchange: async (e) => {
        try {
          const res = await api.saveSettings({ [key]: e.target.value });
          state.me.settings = res.settings;
          toast('saved');
        } catch (err) { toast(errMsg(err), true); }
      },
    },
    h('option', { value: 'everyone', ...(s[key] === 'everyone' ? { selected: '' } : {}) }, 'Everyone'),
    h('option', { value: 'contacts', ...(s[key] === 'contacts' ? { selected: '' } : {}) }, 'People I already talk to'),
    h('option', { value: 'nobody', ...(s[key] === 'nobody' ? { selected: '' } : {}) }, 'Nobody'));
    return h('div', { class: 'field' }, h('label', {}, label), el, h('div', { class: 'muted' }, hint));
  };
  const check = (key, label, hint) => h('label', { class: 'field row switch-row' },
    h('input', { type: 'checkbox', class: 'cb', ...(s[key] ? { checked: true } : {}),
      onchange: async (e) => {
        try {
          const res = await api.saveSettings({ [key]: e.target.checked });
          state.me.settings = res.settings;
          toast('saved');
        } catch (err) { toast(errMsg(err), true); }
      },
    }),
    h('div', {}, h('div', {}, label), h('div', { class: 'muted' }, hint)));

  const notifToggle = h('input', {
    type: 'checkbox', class: 'cb', ...(notifyEnabled() ? { checked: true } : {}),
    onchange: async (e) => {
      if (e.target.checked) {
        if (typeof Notification === 'undefined') {
          toast('notifications are not supported in this browser', true);
          e.target.checked = false;
          return;
        }
        let perm = Notification.permission;
        if (perm === 'default') perm = await Notification.requestPermission();
        if (perm !== 'granted') {
          toast('notifications are blocked — allow them in your browser settings', true);
          e.target.checked = false;
          return;
        }
        localStorage.setItem('pathy.notify', 'on');
        syncPushSubscription(true);
        toast('notifications enabled');
      } else {
        localStorage.setItem('pathy.notify', 'off');
        syncPushSubscription(false);
        toast('notifications disabled');
      }
    },
  });

  return h('div', { class: 'view' },
    viewHeader('Privacy & settings'),
    renderProfileCard(),
    h('div', { class: 'card' },
      h('h3', {}, 'Notifications'),
      h('label', { class: 'field row switch-row' },
        notifToggle,
        h('div', {},
          h('div', {}, 'Notify about new messages'),
          h('div', { class: 'muted' },
            'System notifications when a message arrives while Pathy is in the background. ',
            'On the installed app they arrive even when Pathy is closed (push carries no message content — only who wrote).')))),
    h('div', { class: 'card' },
      h('h3', {}, 'Privacy'),
      sel('whoCanDm', 'Who can send me direct messages',
        'Strangers, only existing contacts, or no one.'),
      sel('whoCanAdd', 'Who can add me to groups & channels',
        'Controls invitations to rooms.'),
      check('discoverable', 'Show me in search results',
        'When off, people can only find you by typing your exact username.'),
      check('showOnline', 'Show my online status',
        'When off, nobody sees whether you are online.')),
    h('div', { class: 'card' },
      h('h3', {}, 'Your identity'),
      h('div', { class: 'muted mb8' },
        'Post-quantum hybrid keys (X-Wing KEM + ML-DSA-65 signatures), generated in this browser. Share this fingerprint so contacts can verify you.'),
      h('div', { class: 'fp' }, store.myFingerprint())),
  );
}

// ---- bots view

function renderBots() {
  const wrap = h('div', { class: 'view' }, viewHeader('Bots'));

  const list = h('div', { class: 'card' }, h('h3', {}, 'Your bots'), h('div', { class: 'muted' }, 'loading…'));
  wrap.append(list);

  api.myBots().then(({ bots }) => {
    list.replaceChildren(h('h3', {}, 'Your bots'),
      bots.length === 0 ? h('div', { class: 'muted' }, 'No bots yet.') : null,
      ...bots.map((b) => h('div', { class: 'member-row' },
        avatarFor(b.username, 'bot'),
        h('div', { class: 'name' }, `@${b.username}`, ' ',
          h('span', { class: 'badge' }, b.hasKeys ? 'keys published' : 'waiting for first run')),
        h('button', {
          class: 'danger small',
          onclick: async () => {
            if (!confirm(`Delete @${b.username}?`)) return;
            try { await api.deleteBot(b.username); renderMain(); } catch (e) { toast(errMsg(e), true); }
          },
        }, 'delete'))));
  }).catch((e) => toast(errMsg(e), true));

  const name = h('input', { placeholder: "bot username — must end with 'bot' (e.g. echobot)", maxlength: '32', 'data-fid': 'bot-name' });
  const err = h('div', { class: 'error-text' });
  wrap.append(h('div', { class: 'card' },
    h('h3', {}, 'Create a bot'),
    h('div', { class: 'field' }, name), err,
    h('button', {
      class: 'primary',
      onclick: async () => {
        err.textContent = '';
        try {
          const res = await api.createBot(name.value.trim().toLowerCase());
          ui.modal = modal('Bot created',
            h('div', { class: 'muted mb8' },
              'This token is shown only once. Put it in the bot’s environment as PATHY_BOT_TOKEN. The bot generates its own E2E keys on first run.'),
            h('div', { class: 'token-box' }, res.token),
            h('div', { class: 'actions' },
              h('button', {
                class: 'ghost',
                onclick: () => navigator.clipboard?.writeText(res.token).then(() => toast('copied')),
              }, icon('copy'), ' Copy'),
              h('button', { class: 'primary', onclick: () => { closeModal(); ui.view = 'bots'; renderMain(); } }, 'Done')));
          renderMain();
        } catch (e) { err.textContent = errMsg(e); }
      },
    }, 'Create bot')));

  wrap.append(h('div', { class: 'card' },
    h('h3', {}, 'How bots work'),
    h('div', { class: 'muted' },
      'Bots are full E2E participants: they hold their own post-quantum keys and the server relays only ciphertext. ',
      'Run the example: PATHY_BOT_TOKEN=<token> npm run bot:echo — then DM the bot or add it to a room. See docs/BOT_API.md.')));
  return wrap;
}

// ------------------------------------------------------------- data flow

async function refreshConversations() {
  const { conversations } = await api.conversations();
  state.conversations = conversations;
  if (ui.activeConvId && !findConv(ui.activeConvId)) ui.activeConvId = null;
  // decrypt sidebar previews lazily
  for (const conv of conversations) {
    if (conv.lastMessage && !(ui.msgs.get(conv.id)?.length)) {
      store.decryptMessage(conv, conv.lastMessage)
        .then((dec) => {
          upsertMessage(conv.id, { ...conv.lastMessage, ...dec });
          renderMain();
        }).catch(() => {});
    }
  }
  renderMain();
}

async function handleWsEvent(ev) {
  if (ev.type === 'message') {
    let conv = findConv(ev.convId);
    if (!conv) { await refreshConversations(); conv = findConv(ev.convId); }
    if (!conv) return;
    const dec = await store.decryptMessage(conv, ev.message);
    // upsert (not push): while we awaited decryption the same message may
    // have been added by the optimistic send path — this was the cause of
    // own messages showing up twice.
    upsertMessage(ev.convId, { ...ev.message, ...dec });
    const active = ui.activeConvId === ev.convId && ui.view === 'chats' && !document.hidden;
    if (ev.message.senderRef !== state.me.ref && !active) {
      ui.unread.set(ev.convId, (ui.unread.get(ev.convId) || 0) + 1);
    }
    if (ev.message.senderRef !== state.me.ref) {
      notifyNewMessage(conv, { ...ev.message, ...dec });
    }
    // keep pinned chats in place; bump the conversation to the top of the
    // unpinned section
    const idx = state.conversations.findIndex((c) => c.id === ev.convId);
    if (idx >= 0 && state.conversations[idx].pinOrder == null) {
      const firstUnpinned = state.conversations.findIndex((c) => c.pinOrder == null);
      if (idx > firstUnpinned) {
        state.conversations.splice(firstUnpinned, 0, state.conversations.splice(idx, 1)[0]);
      }
    }
    if (active) markRead(conv);
    renderMain();
  } else if (ev.type === 'message_edit') {
    const conv = findConv(ev.convId);
    if (!conv) return;
    const list = ui.msgs.get(ev.convId);
    if (list?.some((m) => m.id != null && String(m.id) === String(ev.message.id))) {
      const dec = await store.decryptMessage(conv, ev.message);
      upsertMessage(ev.convId, { ...ev.message, ...dec });
    }
    renderMain();
  } else if (ev.type === 'message_delete') {
    const list = ui.msgs.get(ev.convId);
    if (list) {
      const i = list.findIndex((m) => m.id != null && String(m.id) === String(ev.messageId));
      if (i >= 0) list.splice(i, 1);
    }
    renderMain();
  } else if (ev.type === 'read') {
    const conv = findConv(ev.convId);
    if (conv) {
      conv.reads = conv.reads || {};
      conv.reads[ev.ref] = ev.lastReadId;
      renderMain();
    }
  } else if (ev.type === 'conv_deleted') {
    state.conversations = state.conversations.filter((c) => c.id !== ev.convId);
    forgetConv(ev.convId);
    if (ui.modal) ui.modal = null;
    renderMain();
  } else if (ev.type === 'conv') {
    await refreshConversations();
    const conv = findConv(ev.conversation.id);
    if (conv && ev.envelopes) {
      for (const e of ev.envelopes) await store.acceptEnvelope(conv, e.keyVersion, e.payload);
    }
  } else if (ev.type === 'envelope') {
    const conv = findConv(ev.convId);
    if (conv) {
      for (const e of ev.envelopes) await store.acceptEnvelope(conv, e.keyVersion, e.payload);
      conv.keyVersion = Math.max(conv.keyVersion, ev.keyVersion);
      renderMain();
    } else await refreshConversations();
  } else if (ev.type === 'member') {
    await refreshConversations();
  } else if (ev.type === 'presence') {
    const b = state.bundles.get(ev.ref);
    if (b) { b.online = ev.online; renderMain(); }
  }
}

let listenersInstalled = false;

async function enterApp() {
  onWsEvent(handleWsEvent);
  connectWs();
  if (!listenersInstalled) {
    listenersInstalled = true;
    // coming back to the tab marks the open chat as read
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      const conv = findConv(ui.activeConvId);
      if (conv) { markRead(conv); renderMain(); }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && ui.select && !ui.modal) {
        ui.select = null;
        renderMain();
      }
    });
  }
  syncPushSubscription(notifyEnabled()); // keep this device's push sub fresh
  await refreshConversations();
  render();
}

// ------------------------------------------------------------------ boot

// Service worker: notifications for the installed app (Android requires
// SW-shown notifications) and Web Push while Pathy is closed.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js')
    .then((reg) => { swReg = reg; })
    .catch(() => { /* http without localhost, or SW disabled */ });
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'open-conv' && e.data.convId != null && state.me) {
      const id = state.conversations.find((c) => String(c.id) === String(e.data.convId))?.id;
      if (id != null) openConv(id);
    }
  });
}

// Installed-PWA keyboard fix: when the on-screen keyboard overlays the page
// instead of resizing it (Chrome standalone mode), shrink the app to the
// visual viewport so the composer stays visible above the keyboard.
if (window.visualViewport) {
  const vv = window.visualViewport;
  const sync = () => {
    const keyboard = vv.scale === 1 && window.innerHeight - vv.height > 60;
    if (keyboard) {
      document.documentElement.style.setProperty('--app-h', `${Math.round(vv.height)}px`);
      window.scrollTo(0, 0);
      // keep the conversation pinned to the newest message under the keyboard
      const box = document.querySelector('.messages');
      if (box && box.scrollTop + box.clientHeight >= box.scrollHeight - 160) {
        requestAnimationFrame(() => { box.scrollTop = box.scrollHeight; });
      }
    } else {
      document.documentElement.style.removeProperty('--app-h');
    }
  };
  vv.addEventListener('resize', sync);
  vv.addEventListener('scroll', sync);
  // some keyboards resize without firing visualViewport events right away
  window.addEventListener('focusin', () => setTimeout(sync, 300));
  window.addEventListener('focusout', () => setTimeout(sync, 300));
}

(async () => {
  if (!hasToken()) return render();
  try {
    const me = await api.me();
    state.me = me;
    if (store.tryRestoreSeeds(me.ref)) return enterApp();
    renderAuth({ unlockOnly: true });
  } catch {
    setToken(null);
    render();
  }
})();
