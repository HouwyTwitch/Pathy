// Pathy web client. Rendering is plain DOM (no innerHTML for any
// user-controlled string), state transitions re-render coarsely.
import { api, hasToken, setToken, onWsEvent, connectWs, disconnectWs } from './api.js';
import * as store from './store.js';

const state = store.state;
const ui = {
  view: 'chats',          // chats | settings | bots
  activeConvId: null,
  msgs: new Map(),        // convId -> [{ id, senderRef, ts, body|error, verified }]
  searchResults: null,
  modal: null,
};

const app = document.getElementById('app');

// ------------------------------------------------------------- dom helpers

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
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
  const av = h('div', { class: `avatar av${hue}` },
    kind === 'bot' ? '🤖' : (kind === 'channel' ? '📢' : (kind === 'group' ? '👥' : name[0].toUpperCase())));
  if (online) av.append(h('span', { class: 'dot' }));
  return av;
}

const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function displayName(ref) {
  return ref === state.me?.ref ? 'you' : ref.slice(2) + (ref.startsWith('b:') ? ' 🤖' : '');
}

function convTitle(conv) {
  if (conv.type !== 'dm') return conv.name || '(room)';
  const other = conv.members.find((m) => m.ref !== state.me.ref);
  return other ? displayName(other.ref) : 'dm';
}

function dmPeer(conv) {
  return conv.type === 'dm' ? conv.members.find((m) => m.ref !== state.me.ref)?.ref : null;
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
  const user = h('input', { placeholder: 'username (a-z, 0-9, _)', autocomplete: 'username', maxlength: '32' });
  const pass = h('input', { placeholder: 'password', type: 'password', autocomplete: 'current-password' });
  const btn = h('button', {}, unlockOnly ? 'Unlock' : (authMode === 'login' ? 'Log in' : 'Create account'));

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
      btn.textContent = unlockOnly ? 'Unlock' : (authMode === 'login' ? 'Log in' : 'Create account');
    }
  };

  pass.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  btn.addEventListener('click', submit);

  const card = h('div', { class: 'auth-card' },
    h('h1', {}, '🔐 Pathy'),
    h('div', { class: 'sub muted' },
      'End-to-end encrypted messenger with post-quantum cryptography (X-Wing: X25519 + ML-KEM-768). ',
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
  const sidebar = h('div', { class: 'sidebar' }, renderSidebarTop(), renderSearchOrChats(), renderSidebarBottom());
  const main = h('div', { class: 'main' });
  if (ui.view === 'settings') main.append(renderSettings());
  else if (ui.view === 'bots') main.append(renderBots());
  else if (ui.activeConvId) main.append(...renderChat());
  else main.append(h('div', { class: 'empty-state' }, 'Select a chat, or search for people to message'));

  app.replaceChildren(h('div', { class: 'layout' }, sidebar, main));
  if (ui.modal) app.append(ui.modal);
  const box = app.querySelector('.messages');
  if (box) box.scrollTop = box.scrollTop = box.scrollHeight;
  document.title = 'Pathy';
}

function renderSidebarTop() {
  const input = h('input', {
    placeholder: '🔍 Search people & bots',
    oninput: async (e) => {
      const q = e.target.value.trim();
      if (q.length < 2) { ui.searchResults = null; return renderMain(); }
      try {
        const { results } = await api.search(q);
        ui.searchResults = results;
        renderMain();
        app.querySelector('.sidebar-top input')?.focus();
        const inp = app.querySelector('.sidebar-top input');
        if (inp) { inp.value = q; inp.setSelectionRange(q.length, q.length); }
      } catch { /* ignore transient search errors */ }
    },
  });
  return h('div', { class: 'sidebar-top' },
    input,
    h('button', { class: 'icon-btn', title: 'New group / channel', onclick: () => openCreateRoomModal() }, '✏️'),
  );
}

function renderSearchOrChats() {
  if (ui.searchResults) {
    return h('div', { class: 'chat-list' },
      ui.searchResults.length === 0 ? h('div', { class: 'muted pad12' }, 'No one found') : null,
      ui.searchResults.map((r) =>
        h('div', {
          class: 'search-hit',
          onclick: async () => {
            ui.searchResults = null;
            try {
              const conv = await store.startDm(r.ref);
              await refreshConversations();
              openConv(conv.id);
            } catch (e) { toast(errMsg(e), true); renderMain(); }
          },
        },
        avatarFor(r.username, r.kind),
        h('div', {}, h('div', {}, displayName(r.ref)), h('div', { class: 'muted' }, r.kind)),
        )),
    );
  }
  return h('div', { class: 'chat-list' },
    state.conversations.length === 0
      ? h('div', { class: 'muted pad12' }, 'No chats yet. Search for someone to message, or create a channel with ✏️.')
      : null,
    state.conversations.map((conv) => {
      const peer = dmPeer(conv);
      const online = peer ? state.bundles.get(peer)?.online === true : false;
      const prev = ui.msgs.get(conv.id)?.at(-1);
      const preview = prev ? (prev.error ? '…' : `${prev.senderRef === state.me.ref ? 'you: ' : ''}${prev.body?.text ?? ''}`) : '';
      return h('div', {
        class: `chat-item${conv.id === ui.activeConvId && ui.view === 'chats' ? ' active' : ''}`,
        onclick: () => openConv(conv.id),
      },
      avatarFor(convTitle(conv), conv.type === 'dm' ? (peer?.startsWith('b:') ? 'bot' : 'user') : conv.type, online),
      h('div', { class: 'chat-body' },
        h('div', { class: 'chat-name' }, convTitle(conv),
          conv.type !== 'dm' ? h('span', { class: 'badge' }, conv.type) : null),
        h('div', { class: 'chat-prev' }, preview)),
      );
    }),
  );
}

function renderSidebarBottom() {
  return h('div', { class: 'sidebar-bottom' },
    h('div', { class: 'who' }, `@${state.me.username}`),
    h('button', { class: 'icon-btn', title: 'Bots', onclick: () => { ui.view = 'bots'; renderMain(); } }, '🤖'),
    h('button', { class: 'icon-btn', title: 'Settings', onclick: () => { ui.view = 'settings'; renderMain(); } }, '⚙️'),
    h('button', {
      class: 'icon-btn', title: 'Log out',
      onclick: async () => { await store.logout(); disconnectWs(); render(); },
    }, '🚪'),
  );
}

// ---- chat view

function findConv(id) {
  return state.conversations.find((c) => c.id === id);
}

async function openConv(id) {
  ui.view = 'chats';
  ui.activeConvId = id;
  renderMain();
  const conv = findConv(id);
  if (!conv) return;
  if (!ui.msgs.has(id)) {
    try {
      const { messages } = await api.messages(id);
      const list = [];
      for (const m of messages) list.push({ ...m, ...(await store.decryptMessage(conv, m)) });
      ui.msgs.set(id, list);
    } catch (e) {
      toast(errMsg(e), true);
      ui.msgs.set(id, []);
    }
  }
  const peer = dmPeer(conv);
  if (peer) store.getBundle(peer).then(() => renderMain()).catch(() => {});
  renderMain();
}

function renderChat() {
  const conv = findConv(ui.activeConvId);
  if (!conv) return [h('div', { class: 'empty-state' }, 'This chat no longer exists')];
  const peer = dmPeer(conv);
  const peerInfo = peer ? state.bundles.get(peer) : null;
  const canPost = conv.type !== 'channel' || conv.myRole === 'admin';

  const header = h('div', { class: 'chat-header' },
    avatarFor(convTitle(conv), conv.type === 'dm' ? (peer?.startsWith('b:') ? 'bot' : 'user') : conv.type,
      peerInfo?.online === true),
    h('div', {},
      h('div', { class: 'title' }, convTitle(conv)),
      h('div', { class: 'muted' },
        conv.type === 'dm'
          ? (peer?.startsWith('b:') ? 'bot' : (peerInfo?.online === true ? 'online' : (peerInfo?.online === false ? 'offline' : '')))
          : `${conv.type} · ${conv.members.length} member${conv.members.length > 1 ? 's' : ''} · key v${conv.keyVersion}`)),
    h('div', { class: 'spacer' }),
    h('button', { class: 'ghost small', onclick: () => openInfoModal(conv) }, conv.type === 'dm' ? '🛡 verify' : 'ℹ️ info'),
  );

  const msgs = ui.msgs.get(conv.id) || [];
  const box = h('div', { class: 'messages' },
    msgs.length === 0 ? h('div', { class: 'day-sep' }, 'No messages yet — everything you send is end-to-end encrypted 🔐') : null,
    msgs.map((m) => {
      const mine = m.senderRef === state.me.ref;
      return h('div', { class: `msg${mine ? ' out' : ''}` },
        h('div', { class: 'meta' },
          conv.type !== 'dm' && !mine ? h('span', { class: 'sender' }, displayName(m.senderRef)) : null,
          h('span', { class: 'time' }, fmtTime(m.ts)),
          m.error ? null : (m.verified ? null : h('span', { class: 'unverified', title: 'signature could not be verified' }, '⚠ unverified'))),
        h('div', { class: `bubble${m.error ? ' broken' : ''}` }, m.error ? `⚠ ${m.error}` : (m.body?.text ?? '')),
      );
    }),
  );

  let bottom;
  if (canPost) {
    const input = h('input', { placeholder: 'Message… (encrypted before it leaves this tab)', maxlength: '4096' });
    const send = async () => {
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      try {
        const { id, ts } = await store.sendText(conv, text);
        const list = ui.msgs.get(conv.id) || [];
        if (!list.some((m) => m.id === id)) {
          list.push({ id, senderRef: state.me.ref, ts, body: { t: 'text', text }, verified: true });
          ui.msgs.set(conv.id, list);
        }
        renderMain();
        app.querySelector('.composer input')?.focus();
      } catch (e) { toast(errMsg(e), true); }
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
    bottom = h('div', { class: 'composer' }, input, h('button', { onclick: send }, 'Send'));
  } else {
    bottom = h('div', { class: 'readonly-note' }, '📢 Only admins can post in this channel');
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
    h('div', { class: 'modal' }, h('h3', {}, title), ...content));
}

function openCreateRoomModal() {
  const name = h('input', { placeholder: 'Name', maxlength: '64' });
  const type = h('select', {},
    h('option', { value: 'group' }, 'Group — everyone can post'),
    h('option', { value: 'channel' }, 'Channel — only admins post (like Telegram)'));
  const err = h('div', { class: 'error-text' });
  ui.modal = modal('New group or channel',
    h('div', { class: 'field' }, h('label', {}, 'Type'), type),
    h('div', { class: 'field' }, h('label', {}, 'Name'), name),
    err,
    h('div', { class: 'actions' },
      h('button', { class: 'ghost', onclick: closeModal }, 'Cancel'),
      h('button', {
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

  const rows = conv.members.map((m) => h('div', { class: 'member-row' },
    avatarFor(m.ref.slice(2), m.ref.startsWith('b:') ? 'bot' : 'user'),
    h('div', { class: 'name' }, displayName(m.ref), ' ', m.role === 'admin' ? h('span', { class: 'badge' }, 'admin') : null),
    h('button', {
      class: 'ghost small',
      onclick: async () => {
        try {
          const b = await store.getBundle(m.ref);
          openFingerprintModal(m.ref, b);
        } catch (e) { toast(errMsg(e), true); }
      },
    }, '🛡'),
    isAdmin && m.ref !== state.me.ref
      ? h('button', {
        class: 'danger small',
        onclick: async () => {
          if (!confirm(`Remove ${displayName(m.ref)} and rotate the key?`)) return;
          try {
            await store.removeMemberAndRotate(conv, m.ref);
            await refreshConversations();
            toast('member removed, key rotated 🔁');
            closeModal();
          } catch (e) { toast(errMsg(e), true); }
        },
      }, 'remove')
      : null,
  ));

  if (conv.type === 'dm') {
    const peer = dmPeer(conv);
    store.getBundle(peer).then((b) => openFingerprintModal(peer, b)).catch((e) => toast(errMsg(e), true));
    return;
  }

  ui.modal = modal(`${convTitle(conv)} — ${conv.type}`,
    h('div', { class: 'muted mb10' },
      `Conversation key v${conv.keyVersion}, wrapped per-member with X-Wing (X25519+ML-KEM-768).`),
    ...rows,
    h('div', { class: 'actions' },
      canInvite ? h('button', { class: 'ghost', onclick: () => openInviteModal(conv) }, '➕ Add member') : null,
      isAdmin ? h('button', {
        class: 'ghost',
        title: 'Generate a new conversation key and re-wrap it for all members',
        onclick: async () => {
          try {
            const v = await store.rotateKey(conv);
            await refreshConversations();
            toast(`key rotated to v${v} 🔁`);
            closeModal();
          } catch (e) { toast(errMsg(e), true); }
        },
      }, '🔁 Rotate key') : null,
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
      }, 'Leave'),
      h('button', { class: 'ghost', onclick: closeModal }, 'Close')));
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
    h('div', { class: 'actions' }, h('button', { onclick: closeModal }, 'Done')));
  renderMain();
}

function openInviteModal(conv) {
  const input = h('input', { placeholder: 'Search users and bots…' });
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
            class: 'small',
            onclick: async () => {
              err.textContent = '';
              try {
                await store.invite(conv, r.ref);
                await refreshConversations();
                toast(`${r.username} added — conversation keys shared 🔐`);
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
  const check = (key, label, hint) => h('div', { class: 'field row' },
    h('input', {
      type: 'checkbox', class: 'cb', ...(s[key] ? { checked: '' } : {}),
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
    h('div', { class: 'row spread' },
      h('h2', {}, '⚙️ Privacy & settings'),
      h('button', { class: 'ghost', onclick: () => { ui.view = 'chats'; renderMain(); } }, '← back')),
    h('div', { class: 'card' },
      h('h3', {}, 'Privacy'),
      sel('whoCanDm', 'Who can send me direct messages',
        'Like Telegram: strangers, only existing contacts, or no one.'),
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
  const wrap = h('div', { class: 'view' },
    h('div', { class: 'row spread' },
      h('h2', {}, '🤖 Bots'),
      h('button', { class: 'ghost', onclick: () => { ui.view = 'chats'; renderMain(); } }, '← back')));

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

  const name = h('input', { placeholder: "bot username — must end with 'bot' (e.g. echobot)", maxlength: '32' });
  const err = h('div', { class: 'error-text' });
  wrap.append(h('div', { class: 'card' },
    h('h3', {}, 'Create a bot'),
    h('div', { class: 'field' }, name), err,
    h('button', {
      onclick: async () => {
        err.textContent = '';
        try {
          const res = await api.createBot(name.value.trim().toLowerCase());
          ui.modal = modal('Bot created 🎉',
            h('div', { class: 'muted mb8' },
              'This token is shown only once. Put it in the bot’s environment as PATHY_BOT_TOKEN. The bot generates its own E2E keys on first run.'),
            h('div', { class: 'token-box' }, res.token),
            h('div', { class: 'actions' },
              h('button', {
                class: 'ghost',
                onclick: () => navigator.clipboard?.writeText(res.token).then(() => toast('copied')),
              }, 'Copy'),
              h('button', { onclick: () => { closeModal(); ui.view = 'bots'; renderMain(); } }, 'Done')));
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
  const active = ui.activeConvId && findConv(ui.activeConvId);
  if (ui.activeConvId && !active) ui.activeConvId = null;
  // decrypt previews lazily
  for (const conv of conversations) {
    if (conv.lastMessage && !ui.msgs.has(conv.id)) {
      store.decryptMessage(conv, { ...conv.lastMessage, senderRef: conv.lastMessage.senderRef })
        .then((dec) => {
          if (!ui.msgs.has(conv.id)) {
            ui.msgs.set(conv.id, [{ ...conv.lastMessage, ...dec }]);
            renderMain();
          }
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
    const list = ui.msgs.get(ev.convId);
    if (list && !list.some((m) => m.id === ev.message.id)) {
      list.push({ ...ev.message, ...(await store.decryptMessage(conv, ev.message)) });
    }
    // resort: bump conversation to top
    state.conversations.sort((a, b) =>
      (b.id === ev.convId ? 1 : 0) - (a.id === ev.convId ? 1 : 0));
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
