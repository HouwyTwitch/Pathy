# Pathy Bot API

Telegram-style HTTP API for bots. **Bots are full E2E participants**: they
hold their own X-Wing + ML-DSA keys, and every payload that goes through
these endpoints is ciphertext or public material. If you use the
[Node SDK](../bots/sdk/index.js) you never touch the crypto yourself.

## Creating a bot

In the web UI: **🤖 → Create a bot**. Usernames must match `[a-z0-9_]{3,32}`
and end with `bot`. You get a token `<botId>:<secret>` — shown exactly once.

Equivalent REST call (as a logged-in user):

```
POST /api/bots            { "username": "myecho_bot" }
→ 201 { "ref": "b:myecho_bot", "token": "7:kJ83…" }
```

On first run the bot generates keys locally and publishes the public bundle.
The bundle is **immutable** — a stolen token cannot re-key the bot and
silently take over conversations that members already verified.

## Authentication

All bot endpoints live under `/botapi/<token>/…`. No headers needed.

## Endpoints

| Method & path | Description |
|---|---|
| `GET /getMe` | `{ ref, username, hasKeys }` |
| `POST /setBundle` | publish the public bundle (first write wins) `{ pubBundle }` |
| `GET /getUpdates?offset=&timeout=` | long-poll (timeout ≤ 30 s). Returns `{ updates: [{ updateId, type, payload, ts }] }`. Passing `offset` acknowledges (deletes) everything below it — Telegram semantics: pass `lastUpdateId + 1`. |
| `GET /conversations` | conversations the bot is a member of (incl. `scope`, `keyVersion`, `members`) |
| `GET /conversations/:id/envelopes` | the bot's wrapped conversation keys |
| `GET /conversations/:id/messages?beforeId=&limit=` | ciphertext history |
| `GET /bundles/:ref` | public bundle of `u:<name>` / `b:<name>` (for verifying senders / wrapping) |
| `POST /sendMessage` | `{ convId, keyVersion, n, ct, sig }` — pre-encrypted by the SDK |
| `POST /conversations/:id/blobs` | upload an encrypted attachment (raw `application/octet-stream` body, ≤ 64 MB) → `{ blobId }` |
| `GET /blobs/:id` | download an encrypted attachment from a conversation the bot belongs to |

### Message body types

The decrypted message body is JSON:

| body | Meaning |
|---|---|
| `{ t: "text", text }` | plain text (clients render http(s) links) |
| `{ t: "sticker", emoji }` | a sticker — clients render the emoji large |
| `{ t: "file", name, size, mime, blobId, k, n, … }` | attachment: `blobId` points at an uploaded encrypted blob; `k`/`n` are the file key + nonce (base64url) for `decryptBlob` in [`shared/crypto.js`](../shared/crypto.js). The blob itself is XChaCha20-Poly1305 ciphertext — fetch it via `GET /blobs/:id` and decrypt locally. Extra fields: `w`/`h` (image dimensions), `kind: "voice"` + `dur` seconds (voice notes). |

### Update types

| `type` | Emitted when | Payload highlights |
|---|---|---|
| `message` | a message lands in a conversation the bot belongs to | `convId`, `message { senderRef, keyVersion, n, ct, sig, ts }` |
| `message_edit` | a sender replaced a message's ciphertext | `convId`, `message { …, editedAt }` |
| `message_delete` | a message was deleted for everyone | `convId`, `messageId`, `by` |
| `conv` | the bot is added to a conversation / a DM with the bot is created | `conversation`, initial `envelopes` |
| `conv_deleted` | a conversation the bot belonged to was deleted | `convId`, `by` |
| `envelope` | a key rotation wrapped a new key for the bot | `convId`, `keyVersion`, `envelopes` |
| `member` | membership changes in the bot's conversations | `action: add/remove`, `ref`, `by` |

Updates are persisted server-side until acknowledged, so bots can be offline
and catch up later.

## Behavior & permissions

- Users find bots via search and can always DM them (a user starts the DM and
  wraps the conversation key for the bot).
- Bots **cannot initiate** DMs — like Telegram, the user messages first.
- Bots can be added to groups (by members) and channels (by admins). In
  channels, a bot only posts if it was added with `role: "admin"`.
- Bots never see plaintext of conversations they're not in — there is nothing
  the server could hand them.

## SDK usage

```js
import { PathyBot } from '../sdk/index.js';

const bot = new PathyBot({
  token: process.env.PATHY_BOT_TOKEN,     // required
  baseUrl: process.env.PATHY_BASE_URL,    // default http://localhost:8080
  stateFile: './my-bot-state.json',       // keys + update offset (chmod 600)
});

bot.on('ready',   (me)   => console.log(`@${me.username} online`));
bot.on('joined',  (conv) => console.log('added to', conv.name));
bot.on('error',   (err)  => console.error(err.message));
bot.on('message', async (ctx) => {
  // ctx: { conv, senderRef, text, body, verified, reply(text) }
  if (!ctx.verified) return;              // sender signature didn't verify
  await ctx.reply(`echo: ${ctx.text}`);
});

await bot.start();                        // long-polls until bot.stop()
```

The SDK verifies sender signatures, checks envelope signatures against the
inviter's verified bundle, recomputes DM scopes locally, and transparently
handles key rotation (including the retry when a message races a rotation).

⚠️ The state file contains the bot's **secret seeds**. Protect it like a
private key; mount it on a volume in Docker (see `docker-compose.yml`,
service `echo-bot`).
