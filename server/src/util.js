import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const sha256 = (buf) => createHash('sha256').update(buf).digest();

export const b64uToBuf = (s) => Buffer.from(s, 'base64url');
export const bufToB64u = (b) => Buffer.from(b).toString('base64url');

export const newToken = () => randomBytes(48).toString('base64url');

export function safeEqual(a, b) {
  return a.length === b.length && timingSafeEqual(a, b);
}

// Deterministic decoy salt for unknown usernames, so the login flow does not
// reveal whether an account exists.
const decoySecret = process.env.PATHY_DECOY_SECRET || randomBytes(32).toString('hex');
export const decoySalt = (username) =>
  createHmac('sha256', decoySecret).update(`salt:${username}`).digest().subarray(0, 16).toString('base64url');

export const USERNAME_RE = /^[a-z0-9_]{3,32}$/;
export const REF_RE = /^[ub]:[a-z0-9_]{3,32}$/;
const B64U_RE = /^[A-Za-z0-9_-]+$/;

export function isB64u(s, maxLen, minLen = 1) {
  return typeof s === 'string' && s.length >= minLen && s.length <= maxLen && B64U_RE.test(s);
}

// Public identity bundle as produced by shared/crypto.js makePublicBundle.
// The server can't verify the signature chain semantically (that's the
// clients' job) but enforces shape and size so it never stores junk.
export function isPublicBundle(b) {
  return b && typeof b === 'object' && b.v === 1
    && typeof b.algs === 'string' && b.algs.length <= 64
    && isB64u(b.kem, 2048) && isB64u(b.dsa, 4096) && isB64u(b.sig, 8192);
}

export function isBackup(b) {
  return b && typeof b === 'object' && b.v === 1
    && isB64u(b.n, 64) && isB64u(b.ct, 4096);
}

export function isEnvelope(e) {
  return e && typeof e === 'object' && e.v === 1
    && isB64u(e.kemCt, 4096) && isB64u(e.n, 64) && isB64u(e.wrapped, 512)
    && typeof e.from === 'string' && REF_RE.test(e.from)
    && isB64u(e.sig, 8192);
}

export function isCipherMessage(m) {
  return m && typeof m === 'object'
    && Number.isInteger(m.keyVersion) && m.keyVersion >= 1 && m.keyVersion <= 1e6
    && isB64u(m.n, 64) && isB64u(m.ct, 131072) && isB64u(m.sig, 8192);
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const asyncRoute = (fn) => (req, res, next) => fn(req, res, next).catch(next);
