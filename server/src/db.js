// Postgres access + schema. The schema stores only what a zero-knowledge
// relay needs: hashed credentials, public bundles, encrypted key backups,
// wrapped conversation keys (envelopes) and message ciphertexts.
import pg from 'pg';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id          SERIAL PRIMARY KEY,
  username    TEXT NOT NULL UNIQUE,
  salt        TEXT NOT NULL,
  auth_hash   BYTEA NOT NULL,
  pub_bundle  JSONB NOT NULL,
  backup      JSONB NOT NULL,
  settings    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id          SERIAL PRIMARY KEY,
  token_hash  BYTEA NOT NULL UNIQUE,
  user_id     INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bots (
  id          SERIAL PRIMARY KEY,
  username    TEXT NOT NULL UNIQUE,
  owner_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  BYTEA NOT NULL UNIQUE,
  pub_bundle  JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conversations (
  id             SERIAL PRIMARY KEY,
  type           TEXT NOT NULL CHECK (type IN ('dm','group','channel')),
  name           TEXT,
  -- Deterministic E2E binding scope: 'dm:<sorted member refs>' for DMs
  -- (recomputable by both peers), 'room:<uuid>' for groups/channels. Key
  -- envelopes are cryptographically bound to this string, not to the
  -- server-assigned numeric id.
  scope          TEXT NOT NULL UNIQUE,
  key_version    INT NOT NULL DEFAULT 1,
  created_by_ref TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS members (
  conv_id   INT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  ref       TEXT NOT NULL,
  role      TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
  added_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (conv_id, ref)
);
CREATE INDEX IF NOT EXISTS members_ref_idx ON members(ref);

CREATE TABLE IF NOT EXISTS envelopes (
  id             SERIAL PRIMARY KEY,
  conv_id        INT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  ref            TEXT NOT NULL,
  key_version    INT NOT NULL,
  payload        JSONB NOT NULL,
  created_by_ref TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (conv_id, ref, key_version)
);

CREATE TABLE IF NOT EXISTS messages (
  id          BIGSERIAL PRIMARY KEY,
  conv_id     INT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_ref  TEXT NOT NULL,
  key_version INT NOT NULL,
  n           TEXT NOT NULL,
  ct          TEXT NOT NULL,
  sig         TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_conv_idx ON messages(conv_id, id DESC);

-- Encrypted attachments. Like messages, the server only ever sees
-- ciphertext: clients encrypt files with a random per-file key that travels
-- inside the (E2E-encrypted) message body referencing the blob.
CREATE TABLE IF NOT EXISTS blobs (
  id           UUID PRIMARY KEY,
  conv_id      INT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  uploader_ref TEXT NOT NULL,
  size         INT NOT NULL,
  data         BYTEA NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS blobs_conv_idx ON blobs(conv_id);

CREATE TABLE IF NOT EXISTS bot_updates (
  id         BIGSERIAL PRIMARY KEY,
  bot_id     INT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  payload    JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bot_updates_idx ON bot_updates(bot_id, id);

-- Per-member read cursors (for sent/read ticks).
CREATE TABLE IF NOT EXISTS reads (
  conv_id      INT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  ref          TEXT NOT NULL,
  last_read_id BIGINT NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (conv_id, ref)
);

-- Idempotent migrations for columns added after the initial schema.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited_at  TIMESTAMPTZ;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
-- Profile avatars (public to logged-in users, like usernames).
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar      BYTEA;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_mime TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_rev  INT NOT NULL DEFAULT 0;
-- Per-user pinned-chat ordering (NULL = not pinned; ascending = top first).
ALTER TABLE members ADD COLUMN IF NOT EXISTS pin_order DOUBLE PRECISION;
-- Group/channel avatars (managed by admins; visible to members).
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS avatar      BYTEA;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS avatar_mime TEXT;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS avatar_rev  INT NOT NULL DEFAULT 0;

-- Web Push: server VAPID keypair (generated once) + per-device subscriptions.
-- Pushes carry only metadata the server already knows (conv id, sender ref) —
-- never message content, which the server does not have.
CREATE TABLE IF NOT EXISTS vapid (
  id          INT PRIMARY KEY CHECK (id = 1),
  public_key  TEXT NOT NULL,
  private_key TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS push_subs (
  id         SERIAL PRIMARY KEY,
  user_id    INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint   TEXT NOT NULL UNIQUE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS push_subs_user_idx ON push_subs(user_id);
`;

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL
    || 'postgres://pathy:pathy@localhost:5432/pathy',
  max: 10,
});

export async function initDb({ retries = 30, delayMs = 1000 } = {}) {
  for (let i = 0; ; i++) {
    try {
      await pool.query(SCHEMA);
      return;
    } catch (err) {
      if (i >= retries) throw err;
      console.log(`db not ready (${err.code || err.message}), retrying...`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

export const q = (text, params) => pool.query(text, params);

// True when the two principals already share a conversation — this is the
// "contacts" notion used by the whoCanDm / whoCanAdd privacy settings.
export async function areContacts(refA, refB) {
  const r = await q(
    `SELECT 1 FROM members a JOIN members b ON a.conv_id = b.conv_id
     WHERE a.ref = $1 AND b.ref = $2 LIMIT 1`,
    [refA, refB],
  );
  return r.rowCount > 0;
}

export async function memberOf(convId, ref) {
  const r = await q('SELECT role FROM members WHERE conv_id = $1 AND ref = $2', [convId, ref]);
  return r.rows[0] || null;
}

export async function memberRefs(convId) {
  const r = await q('SELECT ref FROM members WHERE conv_id = $1', [convId]);
  return r.rows.map((x) => x.ref);
}
