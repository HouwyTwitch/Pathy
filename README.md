# 🔐 Pathy

A self-hostable, **end-to-end encrypted messenger** with Telegram-style channels,
direct messages, privacy settings, and a bot API — built on **post-quantum
cryptography**.

The server is a *zero-knowledge relay*: it stores only ciphertext, public keys,
wrapped conversation keys, and hashed credentials. Plaintext, passwords, and
secret keys never leave the client.

## Features

- **Direct messages** — find anyone by username and message them; no friends
  system required.
- **Channels & groups** — Telegram-style: channels are broadcast (only admins
  post), groups let everyone post. Invites wrap the conversation keys to the
  new member's verified public keys; removing a member rotates the key.
- **Privacy settings** (like Telegram): who can DM me
  (everyone / people I already talk to / nobody), who can add me to rooms,
  whether I appear in search, whether my online status is visible.
- **Bot API** — Telegram-style token API with long-polling `getUpdates` and a
  Node SDK. Bots are *first-class E2E participants* with their own
  post-quantum keys; the server can't read bot conversations either.
- **Post-quantum E2E** — X-Wing hybrid KEM (X25519 + ML-KEM-768, the NIST
  FIPS 203 lattice KEM) for key exchange, ML-DSA-65 (FIPS 204) signatures,
  XChaCha20-Poly1305 for content. See [SECURITY.md](SECURITY.md) for the
  model and for why X-Wing was chosen over Classic McEliece.
- **Identity verification** — compare key fingerprints out-of-band, like
  Signal safety numbers / Telegram key visualizations.
- **Realtime** — WebSocket push for messages, key envelopes, membership and
  presence.

## Quick start (Docker Compose)

```bash
cp .env.example .env        # set POSTGRES_PASSWORD
docker compose up -d --build
# open http://localhost:8080
```

To run the example echo bot: create a bot in the web UI (🤖 → *Create a bot*),
put the token into `.env` as `PATHY_BOT_TOKEN`, then:

```bash
docker compose --profile bots up -d --build
```

> **TLS:** run the server behind a TLS-terminating reverse proxy (Caddy,
> nginx, Traefik) in any real deployment, and set `TRUST_PROXY=1`.

## Development without Docker

```bash
npm ci
# needs a Postgres; default DSN is postgres://pathy:pathy@localhost:5432/pathy
DATABASE_URL=postgres://user:pass@host:5432/db npm start
```

Tests (crypto unit tests, full API smoke test, browser test):

```bash
npm run test:crypto                 # primitives + negative cases
npm run smoke                       # against a running server
npm i --no-save playwright \
  && node scripts/browser-test.mjs  # UI test in real Chromium
```

## How the E2E works (short version)

```
identity   = ML-DSA-65 keypair (signs everything) + X-Wing KEM keypair
             public bundle is self-signed and bound to the username;
             clients verify it and can compare fingerprints out-of-band

conversation (DM, group or channel)
           = random 32-byte key per keyVersion
             delivered to each member as an "envelope":
             X-Wing encapsulation → HKDF-SHA256 → XChaCha20-Poly1305 wrap,
             signed by the sender, bound to (scope, keyVersion, member, sender)

message    = XChaCha20-Poly1305(convKey, nonce, AAD=convId|keyVersion|sender)
             + ML-DSA-65 signature over the ciphertext

login      = scrypt(password) → authKey ‖ backupKey
             server sees only authKey (and stores its hash);
             backupKey encrypts the seed backup so you can log in anywhere
```

Everything above happens in the client (browser or bot SDK) via
[`shared/crypto.js`](shared/crypto.js), which is served unmodified to the
browser and imported by Node — one implementation, one wire format.

## Repository layout

```
shared/crypto.js     E2E crypto core (browser + Node, @noble libraries)
server/src/          Express + WebSocket + Postgres relay (ciphertext only)
server/web/          zero-build web client (ES modules + import map)
bots/sdk/            Node bot SDK (Telegram-like API, full E2E)
bots/echo-bot/       example bot
scripts/             crypto tests, API smoke test, browser test
docs/BOT_API.md      bot API reference
SECURITY.md          threat model, crypto rationale, limitations
```

## Bot in 10 lines

```js
import { PathyBot } from './bots/sdk/index.js';

const bot = new PathyBot({ token: process.env.PATHY_BOT_TOKEN });
bot.on('message', async (ctx) => {
  if (ctx.text === '/start') return ctx.reply('hi, I am E2E encrypted 👋');
  await ctx.reply(`echo: ${ctx.text}`);
});
await bot.start();
```

See [docs/BOT_API.md](docs/BOT_API.md) for the raw HTTP API.
