// Browser-level test of the web client using Playwright + system Chromium.
// Covers: import map + CSP, client-side scrypt/keygen, register, channel
// creation, E2E send/receive between two real browser contexts, no duplicate
// own messages, char-by-char search typing, encrypted image/file attachments,
// link rendering, privacy settings UI, and mobile single-pane navigation.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const BASE = process.env.PATHY_BASE_URL || 'http://localhost:8080';
const run = Math.random().toString(36).slice(2, 8);
const log = (s) => console.log(`✔ ${s}`);

const browser = await chromium.launch({
  executablePath: process.env.PW_CHROMIUM || undefined,
});

async function newUser(name, contextOpts = {}) {
  const ctx = await browser.newContext(contextOpts);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error(`[${name}] pageerror:`, e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') console.error(`[${name}] console.error:`, m.text());
  });
  await page.goto(BASE);
  await page.getByRole('button', { name: 'Register' }).click();
  await page.getByPlaceholder('username').fill(`${name}_${run}`);
  await page.getByPlaceholder('password').fill(`browser-pass-${run}!`);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.locator('.sidebar').waitFor({ timeout: 30000 });
  return { ctx, page, username: `${name}_${run}` };
}

const walt = await newUser('walt');
log('walt registered in browser (scrypt + PQC keygen ran client-side)');

// channel create + post
await walt.page.locator('button[title="New group / channel"]').click();
await walt.page.locator('.modal select').selectOption('channel');
await walt.page.locator('.modal input').fill(`browser-news-${run}`);
await walt.page.getByRole('button', { name: 'Create' }).click();
await walt.page.locator('.chat-header').waitFor({ timeout: 15000 });
await walt.page.locator('.composer-input').fill('first post from the browser 📢');
await walt.page.locator('.composer-input').press('Enter');
await walt.page.locator('.msg .bubble .text').first().waitFor({ timeout: 15000 });
assert.equal(
  await walt.page.locator('.msg .bubble .text').first().textContent(),
  'first post from the browser 📢',
);
log('walt created a channel and posted (E2E in browser)');

// the WS echo of an own message must not duplicate the optimistic copy
await walt.page.waitForTimeout(1500);
assert.equal(
  await walt.page.locator('.msg .bubble', { hasText: 'first post from the browser' }).count(),
  1, 'own message must appear exactly once after the WS echo lands',
);
log('own message rendered exactly once (no optimistic/WS duplicate)');

// second user finds walt by *typing* into search (regression: typing used to
// be wiped by re-renders; only pasting worked)
const wendy = await newUser('wendy');
const search = wendy.page.locator('.sidebar-top input');
await search.click();
await search.pressSequentially(walt.username.slice(0, 6), { delay: 80 });
assert.equal(
  await search.inputValue(), walt.username.slice(0, 6),
  'search input must keep text typed character by character',
);
await wendy.page.locator('.search-hit').first().waitFor({ timeout: 15000 });
await wendy.page.locator('.search-hit').first().click();
await wendy.page.locator('.chat-header').waitFor({ timeout: 15000 });
await wendy.page.locator('.composer-input').fill('hi walt, sent from another browser');
await wendy.page.locator('.composer-input').press('Enter');
await wendy.page.locator('.msg .bubble', { hasText: 'hi walt' }).waitFor({ timeout: 15000 });
await wendy.page.waitForTimeout(1500);
assert.equal(
  await wendy.page.locator('.msg .bubble', { hasText: 'hi walt' }).count(),
  1, 'DM must appear exactly once on the sender side',
);
log('wendy found walt by typing in search and sent a DM (shown once)');

// walt receives it live over WS and can decrypt
await walt.page.locator('.chat-item', { hasText: `wendy_${run}` }).waitFor({ timeout: 15000 });
await walt.page.locator('.chat-item', { hasText: `wendy_${run}` }).click();
const bubble = walt.page.locator('.msg .bubble', { hasText: 'hi walt' });
await bubble.waitFor({ timeout: 15000 });
log('walt received + decrypted the DM in realtime (WS push)');

// links in messages are rendered as safe anchors
await wendy.page.locator('.composer-input').fill('docs at https://example.com/pathy?x=1 enjoy');
await wendy.page.locator('.composer-input').press('Enter');
const link = walt.page.locator('.msg .bubble a', { hasText: 'example.com' });
await link.waitFor({ timeout: 15000 });
assert.equal(await link.getAttribute('href'), 'https://example.com/pathy?x=1');
assert.equal(await link.getAttribute('target'), '_blank');
assert.match(await link.getAttribute('rel'), /noopener/);
log('URLs render as clickable, noopener links');

// encrypted image attachment: wendy sends, both sides decrypt + preview
const png1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
await wendy.page.locator('.composer .hidden-file').setInputFiles({
  name: 'pixel.png', mimeType: 'image/png', buffer: png1x1,
});
await wendy.page.locator('.msg.out .img-attach').waitFor({ timeout: 20000 });
await walt.page.locator('.msg .img-attach').waitFor({ timeout: 20000 });
log('image encrypted, uploaded, pushed and decrypted to an inline preview on both sides');

// encrypted binary file attachment: send + download roundtrip on the receiver
const fileBytes = Buffer.from(`secret report ${run} — encrypted end to end`);
await wendy.page.locator('.composer .hidden-file').setInputFiles({
  name: 'report.txt', mimeType: 'text/plain', buffer: fileBytes,
});
const fileRow = walt.page.locator('.msg .file-row', { hasText: 'report.txt' });
await fileRow.waitFor({ timeout: 20000 });
const [download] = await Promise.all([
  walt.page.waitForEvent('download', { timeout: 20000 }),
  fileRow.locator('button.dl').click(),
]);
assert.equal(download.suggestedFilename(), 'report.txt');
const { createReadStream } = await import('node:fs');
const path = await download.path();
const got = await new Promise((resolve, reject) => {
  const chunks = [];
  createReadStream(path).on('data', (c) => chunks.push(c)).on('end', () => resolve(Buffer.concat(chunks))).on('error', reject);
});
assert.deepEqual(got, fileBytes, 'downloaded file must decrypt to the original bytes');
log('binary file: encrypted upload → WS push → download decrypts to identical bytes');

// no unverified badge should be shown
assert.equal(await walt.page.locator('.unverified').count(), 0, 'signatures verified');

// fingerprint modal
await walt.page.getByRole('button', { name: 'verify' }).click();
await walt.page.locator('.fp').first().waitFor();
const fp = await walt.page.locator('.fp').first().textContent();
assert.match(fp.trim(), /^([0-9a-f]{4} ){7}[0-9a-f]{4}$/, 'fingerprint format');
await walt.page.getByRole('button', { name: 'Done' }).click();
log('identity verification modal shows matching-format fingerprints');

// privacy settings roundtrip
await walt.page.locator('button[title="Settings"]').click();
await walt.page.locator('select').first().selectOption('nobody');
await walt.page.locator('.toast').waitFor({ timeout: 10000 });
log('privacy setting saved from UI (whoCanDm=nobody)');

// wendy already has a DM — but a fresh user cannot start one now
const uma = await newUser('uma');
await uma.page.locator('.sidebar-top input').fill(walt.username.slice(0, 6));
await uma.page.locator('.search-hit').first().waitFor({ timeout: 15000 });
await uma.page.locator('.search-hit').first().click();
await uma.page.locator('.toast.err').waitFor({ timeout: 15000 });
log('whoCanDm=nobody blocks a stranger from the UI with a clear error');

// mobile: phone-sized viewport gets single-pane navigation with a back button
const mia = await newUser('mia', {
  viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
});
assert.ok(await mia.page.locator('.sidebar').isVisible(), 'chat list visible on phone');
assert.ok(!(await mia.page.locator('.main').isVisible()), 'chat pane hidden until a chat opens');
const miaSearch = mia.page.locator('.sidebar-top input');
await miaSearch.tap();
await miaSearch.pressSequentially(wendy.username.slice(0, 6), { delay: 60 });
await mia.page.locator('.search-hit').first().tap();
await mia.page.locator('.chat-header').waitFor({ timeout: 15000 });
assert.ok(!(await mia.page.locator('.sidebar').isVisible()), 'list slides away when chat opens');
await mia.page.locator('.composer-input').fill('hello from a phone 📱');
await mia.page.locator('.composer-input').press('Enter');
await mia.page.locator('.msg.out .bubble').waitFor({ timeout: 15000 });
await mia.page.locator('.chat-header .back-btn').tap();
assert.ok(await mia.page.locator('.sidebar').isVisible(), 'back button returns to the chat list');
log('mobile viewport: single-pane layout, tap navigation, back button');

await browser.close();
console.log('\nALL BROWSER TESTS PASSED 🎉');
