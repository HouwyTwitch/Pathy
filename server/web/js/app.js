// Pathy web client. Rendering is plain DOM (no innerHTML for any
// user-controlled string), state transitions re-render coarsely; text inputs
// carry a data-fid marker so value/focus/selection survive re-renders.
import { api, hasToken, setToken, onWsEvent, connectWs, disconnectWs } from './api.js';
import * as store from './store.js';

const state = store.state;
const ui = {
  view: 'chats',          // chats | settings | bots
  activeConvId: null,
  msgs: new Map(),        // convId -> [{ id, localId?, pending?, senderRef, ts, body|error, verified }]
  loaded: new Set(),      // convIds whose history has been fetched
  unread: new Map(),      // convId -> count
  drafts: new Map(),      // convId -> composer draft
  searchQuery: '',
  searchResults: null,
  modal: null,
};

let localSeq = 0;   // ids for optimistic local echoes
let searchSeq = 0;  // drops stale search responses

const app = document.getElementById('app');

// ------------------------------------------------------------- dom helpers

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
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
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  radio: '<circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49m-8.48-.01a6 6 0 0 1 0-8.49m11.31-2.82a10 10 0 0 1 0 14.14m-14.14 0a10 10 0 0 1 0-14.14"/>',
  rotate: '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
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

function avatarFor(name, kind = 'user', online = false) {
  const hue = [...name].reduce((a, c) => a + c.charCodeAt(0) * 7, 0) % 8;
  const glyph = kind === 'bot' ? icon('bot', 'av-icon')
    : kind === 'channel' ? icon('radio', 'av-icon')
      : kind === 'group' ? icon('users', 'av-icon')
        : (name[0] || '?').toUpperCase();
  const av = h('div', { class: `avatar av${hue}` }, glyph);
  if (online) av.append(h('span', { class: 'dot' }));
  return av;
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
  if (existing) Object.assign(existing, msg);
  else list.push(msg);
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
  const oldBox = app.querySelector('.messages');
  const stickBottom = !oldBox
    || oldBox.scrollTop + oldBox.clientHeight >= oldBox.scrollHeight - 48;

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
  if (box && stickBottom) box.scrollTop = box.scrollHeight;
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
  if (b.t === 'file') return `${who}${(b.mime || '').startsWith('image/') ? 'Photo' : (b.name || 'File')}`;
  return `${who}${b.text ?? ''}`;
}

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
        avatarFor(r.username, r.kind),
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
      return h('div', {
        class: `chat-item${conv.id === ui.activeConvId && ui.view === 'chats' ? ' active' : ''}`,
        onclick: () => openConv(conv.id),
      },
      avatarFor(convTitle(conv), avatarKind(conv), online),
      h('div', { class: 'chat-body' },
        h('div', { class: 'chat-row' },
          h('div', { class: 'chat-name' }, convTitle(conv)),
          last ? h('div', { class: 'chat-time' }, fmtTime(last.ts)) : null),
        h('div', { class: 'chat-row' },
          h('div', { class: 'chat-prev' }, msgPreview(last)),
          unread > 0 ? h('div', { class: 'unread-badge' }, unread > 99 ? '99+' : unread) : null)),
      );
    }),
  );
}

function renderSidebarBottom() {
  return h('div', { class: 'sidebar-bottom' },
    avatarFor(state.me.username, 'user'),
    h('div', { class: 'who' }, `@${state.me.username}`),
    h('button', { class: 'icon-btn', title: 'Bots', 'aria-label': 'Bots', onclick: () => { ui.view = 'bots'; ui.activeConvId = null; renderMain(); } }, icon('bot')),
    h('button', { class: 'icon-btn', title: 'Settings', 'aria-label': 'Settings', onclick: () => { ui.view = 'settings'; ui.activeConvId = null; renderMain(); } }, icon('settings')),
    h('button', {
      class: 'icon-btn', title: 'Log out', 'aria-label': 'Log out',
      onclick: async () => { await store.logout(); disconnectWs(); render(); },
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
  }, h('img', { src: url, alt: name || 'image' }));
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

async function sendFiles(conv, files) {
  for (const file of files) {
    if (!file) continue;
    if (file.size === 0) { toast(`${file.name || 'file'}: cannot send an empty file`, true); continue; }
    if (file.size > store.MAX_FILE_BYTES) { toast(`${file.name || 'file'}: too large (max 64 MB)`, true); continue; }
    const localId = `local-${++localSeq}`;
    upsertMessage(conv.id, {
      localId,
      pending: true,
      uploading: 0,
      senderRef: state.me.ref,
      ts: Date.now(),
      verified: true,
      body: { t: 'file', name: file.name || 'file', size: file.size, mime: file.type || 'application/octet-stream' },
    });
    renderMain();
    try {
      const sent = await store.sendFile(conv, file, (p) => updateUploadProgress(localId, p));
      if (sent.body.blobId && (file.type || '').startsWith('image/')) {
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

function fileBubbleContent(m) {
  const b = m.body;
  const isImage = (b.mime || '').startsWith('image/');

  if (m.pending && m.uploading !== undefined) {
    const pct = Math.round((m.uploading || 0) * 100);
    const fill = h('div', { class: 'upload-fill' });
    fill.style.width = `${pct}%`;
    return h('div', { class: 'file-row' },
      h('div', { class: 'file-icon' }, icon(isImage ? 'image' : 'file')),
      h('div', { class: 'file-meta' },
        h('div', { class: 'file-name' }, b.name),
        h('div', { class: 'upload-track' }, fill),
        h('div', { class: 'muted' }, h('span', { class: 'upload-pct' }, `${pct}%`), ` of ${fmtSize(b.size)} — encrypting & uploading`)));
  }

  if (isImage && b.blobId) {
    const entry = (b.size <= AUTOLOAD_IMAGE_BYTES || mediaCache.has(b.blobId)) ? ensureImage(b) : null;
    if (!entry) {
      return h('button', { class: 'file-load ghost', onclick: (e) => { ensureImage(b); e.target.disabled = true; } },
        icon('image'), ` Load image (${fmtSize(b.size)})`);
    }
    if (entry.error) return h('div', { class: 'broken-text' }, `⚠ ${entry.error}`);
    if (entry.loading) return h('div', { class: 'img-loading' }, icon('image'), ' decrypting…');
    return h('img', {
      class: 'img-attach', src: entry.url, alt: b.name,
      onclick: () => openImageViewer(entry.url, b.name),
    });
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

// ---- messages

function renderChat() {
  const conv = findConv(ui.activeConvId);
  if (!conv) return [h('div', { class: 'empty-state' }, 'This chat no longer exists')];
  const peer = dmPeer(conv);
  const peerInfo = peer ? state.bundles.get(peer) : null;
  const canPost = conv.type !== 'channel' || conv.myRole === 'admin';

  const sub = conv.type === 'dm'
    ? (peer?.startsWith('b:') ? 'bot' : (peerInfo?.online === true ? 'online' : (peerInfo?.online === false ? 'offline' : '')))
    : `${conv.type} · ${conv.members.length} member${conv.members.length > 1 ? 's' : ''}`;

  const header = h('div', { class: 'chat-header' },
    h('button', {
      class: 'icon-btn back-btn', title: 'Back', 'aria-label': 'Back',
      onclick: () => { ui.activeConvId = null; renderMain(); },
    }, icon('back')),
    avatarFor(convTitle(conv), avatarKind(conv), peerInfo?.online === true),
    h('div', { class: 'chat-head-text', onclick: () => openInfoModal(conv) },
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

  const msgs = ui.msgs.get(conv.id) || [];
  const rows = [];
  let lastDay = null;
  for (const m of msgs) {
    const day = new Date(m.ts).toDateString();
    if (day !== lastDay) {
      rows.push(h('div', { class: 'day-sep' }, h('span', {}, fmtDay(m.ts))));
      lastDay = day;
    }
    const mine = m.senderRef === state.me.ref;
    const isMedia = !m.error && m.body?.t === 'file' && (m.body.mime || '').startsWith('image/') && !m.uploading && !m.pending;
    rows.push(h('div', { class: `msg${mine ? ' out' : ''}`, 'data-mid': m.localId || m.id },
      conv.type !== 'dm' && !mine
        ? h('div', { class: 'meta' }, h('span', { class: 'sender' }, displayName(m.senderRef)))
        : null,
      h('div', { class: `bubble${m.error ? ' broken' : ''}${isMedia ? ' media' : ''}` },
        m.error ? h('span', { class: 'text' }, `⚠ ${m.error}`)
          : (m.body?.t === 'file' ? fileBubbleContent(m) : h('span', { class: 'text' }, linkify(m.body?.text ?? ''))),
        h('span', { class: 'stamp' },
          !m.error && !m.pending && m.verified === false
            ? h('span', { class: 'unverified', title: 'signature could not be verified' }, '⚠ unverified')
            : null,
          h('span', { class: 'time' }, fmtTime(m.ts)),
          mine ? h('span', { class: 'tick' }, icon(m.pending ? 'clock' : 'check')) : null)),
    ));
  }

  const box = h('div', { class: 'messages' },
    msgs.length === 0
      ? h('div', { class: 'day-sep' }, h('span', {}, 'No messages yet — everything you send is end-to-end encrypted'))
      : null,
    rows);

  let bottom;
  if (canPost) {
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
      placeholder: 'Message',
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
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
    const sendBtn = h('button', { class: 'send-btn', title: 'Send', 'aria-label': 'Send', onclick: send }, icon('send'));
    const syncSend = () => sendBtn.classList.toggle('has-text', input.value.trim().length > 0);
    syncSend();
    bottom = h('div', { class: 'composer' },
      fileInput,
      h('button', {
        class: 'icon-btn', title: 'Attach a file (up to 64 MB)', 'aria-label': 'Attach a file',
        onclick: () => fileInput.click(),
      }, icon('paperclip')),
      input, sendBtn);

    // drag & drop anywhere over the message area
    box.addEventListener('dragover', (e) => { e.preventDefault(); box.classList.add('droppable'); });
    box.addEventListener('dragleave', () => box.classList.remove('droppable'));
    box.addEventListener('drop', (e) => {
      e.preventDefault();
      box.classList.remove('droppable');
      const files = [...(e.dataTransfer?.files || [])];
      if (files.length) sendFiles(conv, files);
    });
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
    avatarFor(m.ref.slice(2), m.ref.startsWith('b:') ? 'bot' : 'user'),
    h('div', { class: 'name' }, displayName(m.ref), ' ', m.role === 'admin' ? h('span', { class: 'badge' }, 'admin') : null),
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

  ui.modal = modal(convTitle(conv),
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
          avatarFor(r.username, r.kind),
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

  return h('div', { class: 'view' },
    viewHeader('Privacy & settings'),
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
    if (ev.message.senderRef !== state.me.ref
      && (ui.activeConvId !== ev.convId || ui.view !== 'chats' || document.hidden)) {
      ui.unread.set(ev.convId, (ui.unread.get(ev.convId) || 0) + 1);
    }
    const idx = state.conversations.findIndex((c) => c.id === ev.convId);
    if (idx > 0) state.conversations.unshift(state.conversations.splice(idx, 1)[0]);
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

async function enterApp() {
  onWsEvent(handleWsEvent);
  connectWs();
  await refreshConversations();
  render();
}

// ------------------------------------------------------------------ boot

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
