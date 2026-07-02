// Pathy end-to-end crypto core.
//
// Runs unmodified in the browser (via import map), the bot SDK, and tests,
// so every principal — human client or bot — speaks the same wire format.
//
// Primitives (all from audited @noble libraries):
//   KEM        X-Wing (X25519 + ML-KEM-768 hybrid, draft-connolly-cfrg-xwing-kem)
//   Signature  ML-DSA-65 (FIPS 204)
//   AEAD       XChaCha20-Poly1305
//   KDF        HKDF-SHA256 (envelope wrap), scrypt (password login/backup)
//
// The server only ever sees the outputs of this module: public bundles,
// key envelopes, ciphertexts, signatures, and the password-*derived* auth
// key. Plaintext, passwords, and secret keys never leave the client.

import { XWing } from '@noble/post-quantum/hybrid.js';
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { scrypt } from '@noble/hashes/scrypt.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from '@noble/hashes/utils.js';

export const ALGS = 'xwing+mldsa65+xchacha20poly1305';

const te = new TextEncoder();
const td = new TextDecoder();

// ---------------------------------------------------------------- encoding

export function toB64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function fromB64(s) {
  const b64 = s.replaceAll('-', '+').replaceAll('_', '/');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Unambiguous canonical serialization for everything we sign or bind as AAD:
// each part (string → UTF-8, or raw bytes) is prefixed with its 32-bit length.
export function canon(parts) {
  const bufs = parts.map((p) => (typeof p === 'string' ? te.encode(p) : p));
  let total = 0;
  for (const b of bufs) total += 4 + b.length;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  let off = 0;
  for (const b of bufs) {
    dv.setUint32(off, b.length);
    out.set(b, off + 4);
    off += 4 + b.length;
  }
  return out;
}

// ---------------------------------------------------------------- identity

// Deterministic keypairs from two 32-byte seeds. Only the seeds are ever
// stored (inside the encrypted backup), keeping the backup tiny.
export function keysFromSeeds(kemSeed, dsaSeed) {
  const kem = XWing.keygen(kemSeed);
  const dsa = ml_dsa65.keygen(dsaSeed);
  return {
    kemSeed, dsaSeed,
    kemPublic: kem.publicKey, kemSecret: kem.secretKey,
    dsaPublic: dsa.publicKey, dsaSecret: dsa.secretKey,
  };
}

export function generateIdentity() {
  return keysFromSeeds(randomBytes(32), randomBytes(32));
}

// Public bundle: the ML-DSA key is the root of identity; it signs the KEM
// key and the owner's name so the server cannot silently swap keys.
export function makePublicBundle(keys, ref) {
  const sig = ml_dsa65.sign(
    canon(['pathy-id-v1', ref, ALGS, keys.kemPublic]),
    keys.dsaSecret,
  );
  return { v: 1, algs: ALGS, kem: toB64(keys.kemPublic), dsa: toB64(keys.dsaPublic), sig: toB64(sig) };
}

export function verifyPublicBundle(bundle, ref) {
  try {
    if (!bundle || bundle.v !== 1 || bundle.algs !== ALGS) return null;
    const kem = fromB64(bundle.kem);
    const dsa = fromB64(bundle.dsa);
    const ok = ml_dsa65.verify(fromB64(bundle.sig), canon(['pathy-id-v1', ref, ALGS, kem]), dsa);
    return ok ? { kem, dsa } : null;
  } catch {
    return null;
  }
}

// Human-comparable fingerprint (like Telegram's encryption key image or
// Signal safety numbers): hash of the verified public keys.
export function fingerprint(bundle, ref) {
  const h = sha256(canon(['pathy-fp-v1', ref, fromB64(bundle.dsa), fromB64(bundle.kem)]));
  const hex = Array.from(h.slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
  return hex.match(/.{4}/g).join(' ');
}

// ---------------------------------------------------------------- passwords

// scrypt(password) → authKey ‖ backupKey.
//   authKey   is sent to the server as the login credential (server stores
//             only a hash of it and never sees the password itself);
//   backupKey encrypts the seed backup so login works from any device while
//             the server holds only an opaque blob.
export function deriveLoginKeys(password, saltB64) {
  const dk = scrypt(te.encode(password.normalize('NFKC')), fromB64(saltB64), {
    N: 2 ** 16, r: 8, p: 1, dkLen: 64,
  });
  return { authKey: toB64(dk.slice(0, 32)), backupKey: dk.slice(32, 64) };
}

export function newSalt() {
  return toB64(randomBytes(16));
}

export function encryptBackup(backupKey, keys, username) {
  const nonce = randomBytes(24);
  const aad = canon(['pathy-backup-v1', username]);
  const pt = te.encode(JSON.stringify({ v: 1, kemSeed: toB64(keys.kemSeed), dsaSeed: toB64(keys.dsaSeed) }));
  const ct = xchacha20poly1305(backupKey, nonce, aad).encrypt(pt);
  return { v: 1, n: toB64(nonce), ct: toB64(ct) };
}

export function decryptBackup(backupKey, blob, username) {
  const aad = canon(['pathy-backup-v1', username]);
  const pt = xchacha20poly1305(backupKey, fromB64(blob.n), aad).decrypt(fromB64(blob.ct));
  const { kemSeed, dsaSeed } = JSON.parse(td.decode(pt));
  return keysFromSeeds(fromB64(kemSeed), fromB64(dsaSeed));
}

// ---------------------------------------------------------------- envelopes

// Every conversation (DM, group, or channel) has a random 32-byte symmetric
// key per keyVersion. It is delivered to each member as an "envelope":
// X-Wing-encapsulated to the member's public key, wrapped with
// XChaCha20-Poly1305, and signed by the wrapping principal's ML-DSA key.
//
// Envelopes are bound to the conversation's *scope* string rather than the
// server-assigned numeric id: 'dm:<sorted refs>' for DMs (each peer can
// recompute it independently) or 'room:<uuid>' chosen by the room creator.

export const dmScope = (refA, refB) => `dm:${[refA, refB].sort().join('|')}`;

export function newConversationKey() {
  return randomBytes(32);
}

export function wrapKey(convKey, scope, keyVersion, memberRef, memberKemPublic, senderRef, senderKeys) {
  const { sharedSecret, cipherText } = XWing.encapsulate(memberKemPublic);
  const wk = hkdf(sha256, sharedSecret, undefined, te.encode('pathy-wrap-v1'), 32);
  const nonce = randomBytes(24);
  const aad = canon(['pathy-env-v1', scope, String(keyVersion), memberRef, senderRef]);
  const wrapped = xchacha20poly1305(wk, nonce, aad).encrypt(convKey);
  const sig = ml_dsa65.sign(
    canon(['pathy-envsig-v1', scope, String(keyVersion), memberRef, senderRef, cipherText, nonce, wrapped]),
    senderKeys.dsaSecret,
  );
  return {
    v: 1,
    kemCt: toB64(cipherText),
    n: toB64(nonce),
    wrapped: toB64(wrapped),
    from: senderRef,
    sig: toB64(sig),
  };
}

// Returns the conversation key, or throws. `senderDsaPublic` must come from
// the *verified* public bundle of `envelope.from`.
export function unwrapKey(envelope, scope, keyVersion, myRef, myKeys, senderDsaPublic) {
  const kemCt = fromB64(envelope.kemCt);
  const nonce = fromB64(envelope.n);
  const wrapped = fromB64(envelope.wrapped);
  const ok = ml_dsa65.verify(
    fromB64(envelope.sig),
    canon(['pathy-envsig-v1', scope, String(keyVersion), myRef, envelope.from, kemCt, nonce, wrapped]),
    senderDsaPublic,
  );
  if (!ok) throw new Error('envelope signature verification failed');
  const sharedSecret = XWing.decapsulate(kemCt, myKeys.kemSecret);
  const wk = hkdf(sha256, sharedSecret, undefined, te.encode('pathy-wrap-v1'), 32);
  const aad = canon(['pathy-env-v1', scope, String(keyVersion), myRef, envelope.from]);
  return xchacha20poly1305(wk, nonce, aad).decrypt(wrapped);
}

// ------------------------------------------------------------- attachments

// Files are encrypted with a random one-off key before upload. The key and
// nonce travel only inside the E2E-encrypted message body that references
// the uploaded blob, so the server never learns anything about the file.

export function newBlobKey() {
  return randomBytes(32);
}

export function encryptBlob(key, bytes) {
  const nonce = randomBytes(24);
  const aad = canon(['pathy-blob-v1']);
  const ct = xchacha20poly1305(key, nonce, aad).encrypt(bytes);
  return { n: toB64(nonce), ct };
}

// Throws if the blob was swapped or corrupted (Poly1305 tag mismatch).
export function decryptBlob(key, nonceB64, ct) {
  const aad = canon(['pathy-blob-v1']);
  return xchacha20poly1305(key, fromB64(nonceB64), aad).decrypt(ct);
}

// ---------------------------------------------------------------- messages

// Message body is a JSON object (e.g. { t:'text', text:'…' }). AAD binds the
// ciphertext to conversation, key version, and sender, so the server cannot
// replay a message into another chat or attribute it to someone else without
// detection. The signature authenticates the sender end-to-end.

export function encryptMessage(convKey, convId, keyVersion, senderRef, senderKeys, body) {
  const nonce = randomBytes(24);
  const aad = canon(['pathy-msg-v1', String(convId), String(keyVersion), senderRef]);
  const ct = xchacha20poly1305(convKey, nonce, aad).encrypt(te.encode(JSON.stringify(body)));
  const sig = ml_dsa65.sign(
    canon(['pathy-msgsig-v1', String(convId), String(keyVersion), senderRef, nonce, ct]),
    senderKeys.dsaSecret,
  );
  return { keyVersion, n: toB64(nonce), ct: toB64(ct), sig: toB64(sig) };
}

// `senderDsaPublic` may be null when the sender's bundle could not be
// verified; decryption then still works but the result is marked unverified.
export function decryptMessage(convKey, convId, msg, senderDsaPublic) {
  const nonce = fromB64(msg.n);
  const ct = fromB64(msg.ct);
  let verified = false;
  if (senderDsaPublic) {
    verified = ml_dsa65.verify(
      fromB64(msg.sig),
      canon(['pathy-msgsig-v1', String(convId), String(msg.keyVersion), msg.senderRef, nonce, ct]),
      senderDsaPublic,
    );
  }
  const aad = canon(['pathy-msg-v1', String(convId), String(msg.keyVersion), msg.senderRef]);
  const pt = xchacha20poly1305(convKey, nonce, aad).decrypt(ct);
  return { body: JSON.parse(td.decode(pt)), verified };
}
