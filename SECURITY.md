# Pathy security model

## Cryptography

| Purpose | Primitive | Notes |
|---|---|---|
| Key encapsulation | **X-Wing** = X25519 + **ML-KEM-768** | draft-connolly-cfrg-xwing-kem; ML-KEM is NIST FIPS 203 |
| Signatures / identity | **ML-DSA-65** | NIST FIPS 204 (Dilithium) |
| Content encryption | **XChaCha20-Poly1305** | AEAD, 24-byte random nonces |
| Key derivation | HKDF-SHA256 | envelope wrap keys |
| Password KDF | scrypt (N=2¹⁶, r=8, p=1) | runs client-side only |

Implementations come from the audited [`@noble`](https://paulmillr.com/noble/)
libraries and are used identically in the browser and in Node
(`shared/crypto.js`).

### Why X-Wing and not Classic McEliece?

Classic McEliece is a fine, conservative KEM, but its public keys are
**~260 KB–1.3 MB**. In a messenger every user publishes a key, every invite
wraps keys for every member, and clients cache bundles — megabyte-scale keys
make that impractical. **ML-KEM-768** (the standardized Kyber) has 1.2 KB
public keys and is the NIST-selected, FIPS-standardized lattice KEM — the
"more reliable" mainstream choice today.

Because lattice cryptanalysis is younger than ECC, Pathy uses the **X-Wing
hybrid**: the shared secret combines an X25519 ECDH secret *and* an ML-KEM-768
encapsulation. Breaking the encryption requires breaking **both** a classical
and a post-quantum assumption — a quantum computer alone (breaks X25519) or a
lattice breakthrough alone (breaks ML-KEM) is not enough.

## What the server can and cannot do

The server stores: usernames, salts, hashes of password-derived auth keys,
self-signed public bundles, password-encrypted key backups, wrapped
conversation keys (envelopes), message ciphertexts + signatures, and
membership rows.

**Cannot** (cryptographically prevented):
- read messages or conversation keys (only members hold them);
- forge messages from a user or bot (ML-DSA signatures, verified client-side);
- silently swap a user's keys — bundles are self-signed and bound to the
  username, and clients expose fingerprints for out-of-band verification;
- move an envelope or message between conversations, key versions, or
  senders (AEAD AAD + signatures bind all of it; DM scopes are recomputed
  client-side from the member pair);
- recover passwords or key backups (only scrypt-derived verifier is seen).

**Can** (accept before deploying):
- see all *metadata*: who talks to whom, when, message sizes, membership of
  channels, presence; this is inherent to a single-relay design;
- withhold, delay, or reorder messages (availability, not confidentiality);
- refuse to deliver key-rotation envelopes (members would keep the old key —
  clients treat missing envelopes as an error, never a fallback);
- observe which usernames exist at registration time (login itself uses
  decoy salts to blunt enumeration).

## Conversation keys, membership and rotation

- Each conversation has a random 32-byte key per `keyVersion`. Members
  receive it wrapped to their X-Wing key, signed by the inviter; clients
  verify both the signature and the inviter's bundle before trusting it.
- **Removing a member** deletes their access server-side *and* the admin
  client immediately rotates to a new key version, re-wrapped only for the
  remaining members. Messages sent after rotation are unreadable to the
  removed member even if they captured all ciphertext (they never receive
  the new key). The server rejects messages encrypted under stale versions.
- Members added later can read history only if the inviter chooses to wrap
  older key versions for them (the default client wraps all it has, matching
  Telegram-group semantics).

## Passwords, sessions, key storage

- `scrypt(password, salt)` runs in the client and is split into an
  **authKey** (sent as the login credential; server stores only its SHA-256)
  and a **backupKey** (never sent; encrypts the identity-seed backup that the
  server stores as an opaque blob). A database leak yields neither passwords
  nor keys.
- Session tokens are random 48-byte values; the server stores only hashes;
  comparisons on the auth path are constant-time.
- In the browser, identity seeds live in memory and in `sessionStorage`
  (tab-lifetime, so a reload doesn't force a full re-login). A new tab
  requires the password again to decrypt the backup. Threat traded: XSS-level
  compromise of the tab already defeats any in-browser E2E scheme; CSP is
  strict (no inline script, no eval, same-origin connect) to keep that bar high.

## Known limitations (read before production use)

1. **No per-message forward secrecy / post-compromise security.** Keys are
   per-conversation with event-driven rotation (member removal, manual
   rotate), not a double-ratchet/MLS. A compromised conversation key exposes
   that key version's messages.
2. **Signatures ⇒ no deniability.** Messages are ML-DSA-signed for
   authenticity; that necessarily creates cryptographic evidence of
   authorship.
3. **Metadata is visible to the server** (see above). Use network-level
   protections (TLS everywhere; Tor/proxies if needed).
4. **TLS is required in deployment** — the compose file serves plain HTTP for
   localhost; put a TLS proxy in front for anything real.
5. **Multi-device is via encrypted seed backup**, not per-device keys; all
   devices share one identity.
6. Rate limiting is in-process (single-node); swap in a shared store when
   scaling horizontally.
7. This is a reference implementation and has **not been externally audited**.

## Reporting

Open a GitHub issue for non-sensitive reports; for sensitive ones contact the
repository owner directly.
