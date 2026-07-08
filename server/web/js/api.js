// Thin REST + WebSocket client. All payloads here are ciphertext/public
// material — encryption happens in store.js before anything reaches this
// layer.

let token = localStorage.getItem('pathy.token') || null;

// Mirror the session token into IndexedDB so the service worker can
// re-register the Web Push subscription when the push service rotates it
// (pushsubscriptionchange can fire with no page open at all).
function mirrorTokenForSw(t) {
  try {
    const req = indexedDB.open('pathy-sw', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('kv', 'readwrite');
      if (t) tx.objectStore('kv').put(t, 'token');
      else tx.objectStore('kv').delete('token');
      tx.oncomplete = () => db.close();
    };
  } catch { /* private mode or IDB disabled */ }
}
mirrorTokenForSw(token);

export function setToken(t) {
  token = t;
  if (t) localStorage.setItem('pathy.token', t);
  else localStorage.removeItem('pathy.token');
  mirrorTokenForSw(t);
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
  editMessage: (id, mid, m) => call('PUT', `/conversations/${id}/messages/${mid}`, m),
  deleteMessage: (id, mid) => call('DELETE', `/conversations/${id}/messages/${mid}`),
  markRead: (id, lastReadId) => call('POST', `/conversations/${id}/read`, { lastReadId }),
  deleteConversation: (id) => call('DELETE', `/conversations/${id}`),
  savePins: (order) => call('PUT', '/me/pins', { order }),
  deleteAvatar: () => call('DELETE', '/me/avatar'),
  uploadAvatar,
  fetchAvatar,
  vapidKey: () => call('GET', '/push/vapid'),
  deleteConvAvatar: (id) => call('DELETE', `/conversations/${id}/avatar`),
  uploadConvAvatar: (id, blob) => putBinary(`/api/conversations/${id}/avatar`, blob),
  fetchConvAvatar: (id, rev) => fetchImage(`/api/conversations/${id}/avatar?v=${rev}`),
  savePushSub: (sub) => call('POST', '/me/push-subscriptions', sub),
  deletePushSub: (endpoint) => call('DELETE', '/me/push-subscriptions', { endpoint }),
  addMember: (id, b) => call('POST', `/conversations/${id}/members`, b),
  removeMember: (id, ref) => call('DELETE', `/conversations/${id}/members/${encodeURIComponent(ref)}`),
  rotate: (id, b) => call('POST', `/conversations/${id}/rotate`, b),
  myBots: () => call('GET', '/bots'),
  createBot: (username) => call('POST', '/bots', { username }),
  deleteBot: (username) => call('DELETE', `/bots/${encodeURIComponent(username)}`),
  initBlob: (convId, size, chunkBytes) =>
    call('POST', `/conversations/${convId}/blobs`, { size, chunkBytes }),
  uploadChunk,
  fetchBlob,
  fetchBlobResponse,
  stickerPacks: () => call('GET', '/stickers/packs'),
  createStickerPack: (title) => call('POST', '/stickers/packs', { title }),
  stickerPack: (id) => call('GET', `/stickers/packs/${id}`),
  installStickerPack: (id) => call('POST', `/stickers/packs/${id}/install`),
  deleteStickerPack: (id) => call('DELETE', `/stickers/packs/${id}`),
  uploadSticker: (packId, blob, meta = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(meta)) if (v) qs.set(k, v);
    return putBinary(`/api/stickers/packs/${packId}/stickers?${qs}`, blob, 'POST');
  },
  deleteSticker: (sid) => call('DELETE', `/stickers/sticker/${sid}`),
  fetchSticker: (sid) => fetchImage(`/api/stickers/sticker/${sid}/image`),
  importTelegramPack: (name) => call('POST', '/stickers/import-telegram', { name }),
};

// Upload one encrypted chunk. XHR instead of fetch so we can report
// within-chunk upload progress for large files.
function uploadChunk(blobId, idx, bytes, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `/api/blobs/${encodeURIComponent(blobId)}/chunks/${idx}`);
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    if (token) xhr.setRequestHeader('authorization', `Bearer ${token}`);
    xhr.responseType = 'json';
    if (onProgress) {
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) onProgress(e.loaded / e.total);
      });
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.response);
      else reject(new ApiError(xhr.status, xhr.response?.error || `http ${xhr.status}`));
    };
    xhr.onerror = () => reject(new ApiError(0, 'upload failed — check your connection'));
    xhr.send(bytes);
  });
}

async function fetchBlobResponse(blobId) {
  const res = await fetch(`/api/blobs/${encodeURIComponent(blobId)}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    let data = null;
    try { data = await res.json(); } catch { /* not json */ }
    throw new ApiError(res.status, data?.error || `http ${res.status}`);
  }
  return res;
}

async function fetchBlob(blobId) {
  return new Uint8Array(await (await fetchBlobResponse(blobId)).arrayBuffer());
}

async function putBinary(url, blob, method = 'PUT') {
  const res = await fetch(url, {
    method,
    headers: {
      'content-type': blob.type || 'image/jpeg',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: blob,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data?.error || `http ${res.status}`);
  return data;
}

// Avatars are plain images behind session auth, so <img src> can't load
// them directly — fetch with the bearer token and hand back a Blob.
async function fetchImage(url) {
  const res = await fetch(url, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new ApiError(res.status, 'no avatar');
  return res.blob();
}

function uploadAvatar(blob) {
  return putBinary('/api/me/avatar', blob);
}

function fetchAvatar(ref, rev) {
  return fetchImage(`/api/avatars/${encodeURIComponent(ref)}?v=${rev}`);
}

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

// Fire-and-forget client → server frame (typing indicators etc).
export function wsSend(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(obj)); } catch { /* racing a close */ }
  }
}
