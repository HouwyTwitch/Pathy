// Disk-backed storage for large encrypted attachments (up to 2 GB).
// Postgres BYTEA rows cap out around 1 GB and bloat the database, so v2
// blobs are streamed to plain files; the blobs table keeps metadata and
// upload progress. Files hold pure ciphertext — leaking the directory
// reveals nothing without the per-file keys inside E2E message bodies.
import { createReadStream } from 'node:fs';
import { mkdir, appendFile, unlink, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const BLOB_DIR = process.env.BLOB_DIR
  || path.resolve(__dirname, '..', '..', 'data', 'blobs');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function initBlobDir() {
  await mkdir(BLOB_DIR, { recursive: true });
}

export function blobPath(id) {
  if (!UUID_RE.test(id)) throw new Error('bad blob id');
  return path.join(BLOB_DIR, id);
}

export function appendChunk(id, buf) {
  return appendFile(blobPath(id), buf);
}

export async function blobSize(id) {
  return (await stat(blobPath(id))).size;
}

export function streamBlob(id) {
  return createReadStream(blobPath(id));
}

export async function removeBlobFile(id) {
  try { await unlink(blobPath(id)); } catch { /* already gone */ }
}
