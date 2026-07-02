// Thin REST + WebSocket client. All payloads here are ciphertext/public
// material — encryption happens in store.js before anything reaches this
// layer.

let token = localStorage.getItem('pathy.token') || null;

export function setToken(t) {
  token = t;
  if (t) localStorage.setItem('pathy.token', t);
  else localStorage.removeItem('pathy.token');
}

export const hasToken = () => !!token;

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function call(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw new ApiError(res.status, data?.error || `http ${res.status}`);
  return data;
}

export const api = {
  register: (b) => call('POST', '/register', b),
  loginSalt: (username) => call('POST', '/login/salt', { username }),
  login: (b) => call('POST', '/login', b),
  logout: () => call('POST', '/logout'),
  me: () => call('GET', '/me'),
  saveSettings: (s) => call('PUT', '/me/settings', s),
  search: (q) => call('GET', `/users/search?q=${encodeURIComponent(q)}`),
  bundle: (ref) => call('GET', `/bundles/${encodeURIComponent(ref)}`),
  conversations: () => call('GET', '/conversations'),
  conversation: (id) => call('GET', `/conversations/${id}`),
  createConversation: (b) => call('POST', '/conversations', b),
  envelopes: (id) => call('GET', `/conversations/${id}/envelopes`),
  messages: (id, beforeId) =>
    call('GET', `/conversations/${id}/messages?limit=50${beforeId ? `&beforeId=${beforeId}` : ''}`),
  sendMessage: (id, m) => call('POST', `/conversations/${id}/messages`, m),
  addMember: (id, b) => call('POST', `/conversations/${id}/members`, b),
  removeMember: (id, ref) => call('DELETE', `/conversations/${id}/members/${encodeURIComponent(ref)}`),
  rotate: (id, b) => call('POST', `/conversations/${id}/rotate`, b),
  myBots: () => call('GET', '/bots'),
  createBot: (username) => call('POST', '/bots', { username }),
  deleteBot: (username) => call('DELETE', `/bots/${encodeURIComponent(username)}`),
};

// ------------------------------------------------------------- websocket

let ws = null;
let wsHandlers = [];
let reconnectDelay = 1000;
let closedByUser = false;

export function onWsEvent(fn) {
  wsHandlers.push(fn);
}

export function connectWs() {
  if (!token) return;
  closedByUser = false;
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws`);
  ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', token }));
  ws.onmessage = (ev) => {
    let event;
    try { event = JSON.parse(ev.data); } catch { return; }
    if (event.type === 'ready') reconnectDelay = 1000;
    for (const fn of wsHandlers) fn(event);
  };
  ws.onclose = () => {
    ws = null;
    if (closedByUser) return;
    setTimeout(connectWs, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 15000);
  };
}

export function disconnectWs() {
  closedByUser = true;
  if (ws) ws.close();
  ws = null;
}
