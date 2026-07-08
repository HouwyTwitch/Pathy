// Diagnose Telegram sticker-import connectivity step by step. Run it on the
// machine that hosts Pathy — it uses the exact same transport as the server
// (undici + optional TELEGRAM_PROXY), so if this script passes, the in-app
// import works too.
//
// Inside the deployed container (env vars already set):
//   docker compose exec server node scripts/tg-check.mjs
//   docker compose exec server node scripts/tg-check.mjs https://t.me/addstickers/SomePack
//
// Or standalone (after `npm ci`):
//   TELEGRAM_BOT_TOKEN=123:abc TELEGRAM_PROXY=http://user:pass@ip:port \
//     node scripts/tg-check.mjs [pack]
import { fetch as proxiedFetch, ProxyAgent } from 'undici';

const token = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const proxy = String(process.env.TELEGRAM_PROXY || '').trim();
const packArg = String(process.argv[2] || '').trim();
const packMatch = /(?:t\.me\/addstickers\/|tg:\/\/addstickers\?set=)?([A-Za-z0-9_]+)$/.exec(packArg);
const pack = packArg ? packMatch?.[1] : 'HotCherry'; // a well-known public pack

const ok = (s) => console.log(`  \x1b[32m✔\x1b[0m ${s}`);
const bad = (s) => { console.log(`  \x1b[31m✖\x1b[0m ${s}`); process.exitCode = 1; };
const why = (e) => e?.cause?.code || e?.cause?.message || e?.message || e?.name || 'unknown error';

console.log('— configuration');
if (!token) {
  bad('TELEGRAM_BOT_TOKEN is not set');
} else if (!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token)) {
  bad(`TELEGRAM_BOT_TOKEN looks malformed: "${token.slice(0, 8)}…" — paste it from @BotFather as-is (digits:letters, no quotes)`);
} else {
  ok(`TELEGRAM_BOT_TOKEN present (bot id ${token.split(':')[0]})`);
}

let dispatcher = null;
if (proxy) {
  try {
    const u = new URL(proxy);
    if (!/^https?:$/.test(u.protocol)) throw new Error('scheme');
    dispatcher = new ProxyAgent(proxy);
    ok(`TELEGRAM_PROXY: ${u.protocol}//${u.host} (auth: ${u.username ? 'yes' : 'no'})`);
  } catch {
    bad(`TELEGRAM_PROXY is not a valid http(s) proxy URL: use http://user:pass@host:port`);
  }
} else {
  console.log('  · TELEGRAM_PROXY not set — connecting directly');
}
if (process.exitCode) process.exit();

async function call(method, params, { direct = false, timeoutMs = 12_000 } = {}) {
  const url = new URL(`https://api.telegram.org/bot${token}/${method}`);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  const opts = { signal: AbortSignal.timeout(timeoutMs) };
  const res = (!direct && dispatcher)
    ? await proxiedFetch(url, { ...opts, dispatcher })
    : await fetch(url, opts);
  const data = await res.json().catch(() => null);
  if (!data?.ok) {
    const e = new Error(`telegram answered: ${data?.description || `http ${res.status}`}`);
    e.api = true; // transport worked — this is an API-level reply
    throw e;
  }
  return data.result;
}

console.log('— reachability');
try {
  const me = await call('getMe', {}, { direct: true, timeoutMs: 8_000 });
  ok(`api.telegram.org reachable DIRECTLY (bot @${me.username})`);
} catch (e) {
  if (e.api) {
    bad(`reached api.telegram.org directly, but: ${e.message} — is the bot token valid?`);
  } else {
    const note = dispatcher ? ' (fine if the proxy works below)' : ' — if Telegram is blocked in your network, set TELEGRAM_PROXY';
    bad(`direct connection failed: ${why(e)}${note}`);
    if (dispatcher) process.exitCode = 0; // direct being blocked is expected with a proxy
  }
}
if (dispatcher) {
  try {
    const me = await call('getMe', {});
    ok(`api.telegram.org reachable VIA PROXY (bot @${me.username})`);
  } catch (e) {
    if (e.api) bad(`proxy works, but telegram rejected the call: ${e.message} — is the bot token valid?`);
    else bad(`proxy connection failed: ${why(e)} — check the proxy address, credentials and that it allows CONNECT to port 443`);
  }
}
if (process.exitCode) process.exit();

console.log(`— sticker pack "${pack}"`);
try {
  const set = await call('getStickerSet', { name: pack });
  ok(`getStickerSet: "${set.title}", ${set.stickers?.length ?? 0} stickers`);
  const s = set.stickers?.[0];
  if (s) {
    const f = await call('getFile', { file_id: s.file_id });
    const dl = dispatcher
      ? await proxiedFetch(`https://api.telegram.org/file/bot${token}/${f.file_path}`, { signal: AbortSignal.timeout(20_000), dispatcher })
      : await fetch(`https://api.telegram.org/file/bot${token}/${f.file_path}`, { signal: AbortSignal.timeout(20_000) });
    if (!dl.ok) throw new Error(`file download: http ${dl.status}`);
    const bytes = Buffer.from(await dl.arrayBuffer());
    ok(`downloaded first sticker: ${bytes.length} bytes (${f.file_path})`);
  }
} catch (e) {
  bad(`${why(e)}`);
}

console.log(process.exitCode
  ? '\nRESULT: something failed above — the in-app import will fail the same way.'
  : '\nRESULT: everything works — sticker import in Pathy should succeed.');
