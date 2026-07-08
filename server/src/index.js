import http from 'node:http';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { initDb, pool } from './db.js';
import { initPush } from './push.js';
import { initBlobDir } from './blobstore.js';
import { HttpError } from './util.js';
import { api } from './routes/api.js';
import { botapi } from './routes/botapi.js';
import { attachWs } from './ws.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);

// The only inline script is the import map in index.html; allow exactly it
// by hash, computed from the file at boot so edits can't silently break CSP.
const indexHtml = readFileSync(path.join(repoRoot, 'server', 'web', 'index.html'), 'utf8');
const importMapSrc = /<script type="importmap">([\s\S]*?)<\/script>/.exec(indexHtml)?.[1] ?? '';
const importMapHash = `'sha256-${createHash('sha256').update(importMapSrc).digest('base64')}'`;

app.use((req, res, next) => {
  // Strict CSP: no inline scripts/styles anywhere in the client (the import
  // map is hash-pinned). ws:/wss: are listed because some engines don't fold
  // same-origin WebSockets into 'self'.
  res.set({
    'Content-Security-Policy':
      `default-src 'none'; script-src 'self' ${importMapHash}; style-src 'self'; img-src 'self' data: blob:; `
      + "media-src 'self' blob:; connect-src 'self' ws: wss:; manifest-src 'self'; worker-src 'self'; "
      + "base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(self), microphone=(self), geolocation=()', // mic: voice notes, camera: video circles
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
  next();
});

app.use(express.json({ limit: '2mb' }));

app.get('/healthz', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});

app.use('/api', api);
app.use('/botapi/:token', botapi);

// Browser code: the SPA, the shared E2E crypto core, and the audited @noble
// modules straight from node_modules (JS only), wired up via an import map
// in index.html — no bundler involved.
// HTML and the service worker must revalidate so installed apps pick up UI
// updates promptly; hashed-free assets keep a short cache.
const staticOpts = {
  index: false,
  maxAge: '1h',
  fallthrough: true,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html') || filePath.endsWith('sw.js')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
};
app.use('/shared', express.static(path.join(repoRoot, 'shared'), staticOpts));
app.use('/vendor/@noble', (req, res, next) => {
  if (!req.path.endsWith('.js')) return res.status(404).end();
  next();
});
app.use('/vendor/@noble', express.static(path.join(repoRoot, 'node_modules', '@noble'), staticOpts));
// Lottie player (animated .tgs stickers) — lazy-imported by the client.
app.use('/vendor/lottie-web', (req, res, next) => {
  if (!req.path.endsWith('.js')) return res.status(404).end();
  next();
});
app.use('/vendor/lottie-web', express.static(path.join(repoRoot, 'node_modules', 'lottie-web'), staticOpts));
app.use(express.static(path.join(repoRoot, 'server', 'web'), { ...staticOpts, index: 'index.html' }));

app.use((req, res) => res.status(404).json({ error: 'not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'payload too large' });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid json' });
  console.error(err);
  res.status(500).json({ error: 'internal error' });
});

const port = Number(process.env.PORT) || 8080;

await initDb();
await initPush();
await initBlobDir();
const server = http.createServer(app);
attachWs(server);
server.listen(port, () => console.log(`pathy server listening on :${port}`));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
