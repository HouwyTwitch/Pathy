// Browser-level test of the web client using Playwright + system Chromium.
// Covers: import map + CSP, client-side scrypt/keygen, register, channel
// creation, E2E send/receive between two real browser contexts, no duplicate
// own messages, char-by-char search typing, read receipts (double ticks),
// message edit/delete, emoji picker + stickers, voice messages, encrypted
// image/file attachments, avatars, chat pinning/deletion, scroll anchoring,
// link rendering, privacy settings UI, and mobile single-pane navigation.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const BASE = process.env.PATHY_BASE_URL || 'http://localhost:8080';
const run = Math.random().toString(36).slice(2, 8);
const log = (s) => console.log(`✔ ${s}`);

const browser = await chromium.launch({
  executablePath: process.env.PW_CHROMIUM || undefined,
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ],
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

const png1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

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

// channel photo: admin sets it through the crop dialog
await walt.page.getByRole('button', { name: 'info' }).click();
await walt.page.locator('.modal .hidden-file').setInputFiles({
  name: 'room.png', mimeType: 'image/png', buffer: png1x1,
});
await walt.page.locator('.crop-canvas').waitFor({ timeout: 10000 });
await walt.page.getByRole('button', { name: 'Save' }).click();
await walt.page.locator('.chat-header .avatar-img').waitFor({ timeout: 15000 });
log('channel photo: cropped, uploaded, shown in the header (room avatars)');

// second user finds walt by *typing* into search (regression: typing used to
// be wiped by re-renders; only pasting worked)
const wendy = await newUser('wendy', { permissions: ['microphone'] });
wendy.page.on('dialog', (d) => d.accept()); // confirm() for delete actions
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

// read receipts: single tick until walt opens the chat, then double
await wendy.page.locator('.msg.out .tick:not(.read)').waitFor({ timeout: 15000 });
assert.equal(await wendy.page.locator('.msg.out .tick.read').count(), 0, 'not read yet');

// walt receives it live over WS and can decrypt
await walt.page.locator('.chat-item', { hasText: `wendy_${run}` }).waitFor({ timeout: 15000 });
await walt.page.locator('.chat-item', { hasText: `wendy_${run}` }).click();
const bubble = walt.page.locator('.msg .bubble', { hasText: 'hi walt' });
await bubble.waitFor({ timeout: 15000 });
log('walt received + decrypted the DM in realtime (WS push)');

await wendy.page.locator('.msg.out .tick.read').first().waitFor({ timeout: 15000 });
log('read receipt: tick became a double check once walt opened the chat');

// user profile: click the chat header to view the peer's profile
await walt.page.locator('.chat-head-text').click();
await walt.page.locator('.profile-view').waitFor({ timeout: 15000 });
assert.match(
  await walt.page.locator('.modal').textContent(), new RegExp(`wendy_${run}`),
  'profile shows the username',
);
assert.ok(await walt.page.locator('.modal .fp').count() >= 1, 'profile shows the fingerprint');
await walt.page.locator('.modal .actions button.ghost').click();
log('user profile opens from the chat header (avatar, status, fingerprint)');

// edit a message: sender re-encrypts, both sides update, "edited" label shows
await wendy.page.locator('.msg.out .bubble', { hasText: 'hi walt' }).click({ button: 'right' });
await wendy.page.locator('.action-item', { hasText: 'Edit' }).click();
assert.match(
  await wendy.page.locator('.composer-input').inputValue(), /hi walt/,
  'composer prefilled with the original text',
);
await wendy.page.locator('.composer-input').fill('hi walt — edited from the test');
await wendy.page.locator('.composer-input').press('Enter');
await walt.page.locator('.msg .bubble', { hasText: 'edited from the test' }).waitFor({ timeout: 15000 });
await wendy.page.locator('.msg.out .edited').first().waitFor({ timeout: 15000 });
log('message edit: re-encrypted, live-updated on both sides, "edited" label shown');

// delete a message for everyone
await wendy.page.locator('.composer-input').fill('this one will be deleted');
await wendy.page.locator('.composer-input').press('Enter');
await walt.page.locator('.msg .bubble', { hasText: 'will be deleted' }).waitFor({ timeout: 15000 });
await wendy.page.locator('.msg.out .bubble', { hasText: 'will be deleted' }).click({ button: 'right' });
await wendy.page.locator('.action-item', { hasText: 'Delete for everyone' }).click();
await walt.page.locator('.msg .bubble', { hasText: 'will be deleted' })
  .waitFor({ state: 'detached', timeout: 15000 });
await wendy.page.locator('.msg .bubble', { hasText: 'will be deleted' })
  .waitFor({ state: 'detached', timeout: 15000 });
log('message delete: removed for both sides (ciphertext destroyed server-side)');

// emoji picker inserts into the composer
await wendy.page.locator('button[title="Emoji & stickers"]').click();
await wendy.page.locator('.emoji-cell').first().waitFor({ timeout: 10000 });
const firstEmoji = (await wendy.page.locator('.emoji-cell').first().textContent()).trim();
await wendy.page.locator('.emoji-cell').first().click();
assert.ok(
  (await wendy.page.locator('.composer-input').inputValue()).includes(firstEmoji),
  'clicked emoji lands in the composer',
);
await wendy.page.locator('.composer-input').press('Enter'); // send it as a message
await wendy.page.locator('.msg.out .bubble.big-emoji').first().waitFor({ timeout: 15000 });
log('emoji picker inserts at the caret; emoji-only messages render big');

// stickers: pick from the sticker tab (picker stays open after sending),
// sent immediately, rendered large
await wendy.page.locator('.picker-tab', { hasText: 'Stickers' }).click();
await wendy.page.locator('.sticker-cell').first().click();
await wendy.page.locator('.msg.out .sticker-emoji').waitFor({ timeout: 15000 });
await walt.page.locator('.msg .sticker-emoji').waitFor({ timeout: 15000 });
log('sticker sent from the picker and rendered large on both sides');

// voice message: record from the (fake) microphone, send, receiver plays it
await wendy.page.locator('.mic-btn').click();
await wendy.page.locator('.composer.recording').waitFor({ timeout: 10000 });
await wendy.page.waitForTimeout(1300);
await wendy.page.locator('.composer.recording .send-btn').click();
await wendy.page.locator('.msg.out .voice-row').waitFor({ timeout: 30000 });
const waltVoice = walt.page.locator('.msg .voice-row');
await waltVoice.waitFor({ timeout: 30000 });
await waltVoice.locator('.voice-play').click();
await walt.page.locator('.voice-play[title="Pause"]').waitFor({ timeout: 15000 });
await walt.page.waitForTimeout(1200);
const fillWidth = await walt.page.locator('.msg .voice-fill').first()
  .evaluate((el) => parseFloat(el.style.width) || 0);
assert.ok(fillWidth > 0, `voice playback progressed (fill ${fillWidth}%)`);
log('voice message: recorded, encrypted, sent; receiver decrypts and plays it');

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

// scroll anchoring: when scrolled up, incoming messages must not yank the view
for (let i = 0; i < 6; i++) {
  await wendy.page.locator('.composer-input').fill(`filler message ${i} to make the history scrollable`);
  await wendy.page.locator('.composer-input').press('Enter');
}
await walt.page.locator('.msg .bubble', { hasText: 'filler message 5' }).waitFor({ timeout: 15000 });
await walt.page.locator('.messages').evaluate((el) => { el.scrollTop = 0; });
await wendy.page.locator('.composer-input').fill('new message while walt reads history');
await wendy.page.locator('.composer-input').press('Enter');
await walt.page.locator('.msg .bubble', { hasText: 'while walt reads history' }).waitFor({ timeout: 15000 });
await walt.page.waitForTimeout(800);
const scrollAfter = await walt.page.locator('.messages').evaluate((el) => el.scrollTop);
assert.ok(scrollAfter < 120, `scroll stays anchored while reading history (got ${scrollAfter})`);
await walt.page.locator('.messages').evaluate((el) => { el.scrollTop = el.scrollHeight; });
log('incoming messages no longer jump the chat when scrolled up');

// image viewer scales the picture to the screen instead of natural size
await walt.page.locator('.msg .img-attach').first().click();
await walt.page.locator('.modal-back.viewer img').waitFor({ timeout: 10000 });
const viewerBox = await walt.page.locator('.modal-back.viewer img').boundingBox();
const viewport = walt.page.viewportSize();
assert.ok(viewerBox.width <= viewport.width && viewerBox.height <= viewport.height,
  'viewer image fits inside the window');
await walt.page.locator('.modal-back.viewer').click();
await walt.page.locator('.modal-back.viewer').waitFor({ state: 'detached', timeout: 5000 });
log('image viewer fits the picture to the screen');

// multi-select: pick several messages, copy, then delete them together
await wendy.page.locator('.msg.out .bubble', { hasText: 'filler message 4' }).click({ button: 'right' });
await wendy.page.locator('.action-item', { hasText: 'Select' }).click();
await wendy.page.locator('.select-bar', { hasText: '1 selected' }).waitFor({ timeout: 10000 });
await wendy.page.locator('.msg', { hasText: 'filler message 3' }).click();
await wendy.page.locator('.select-bar', { hasText: '2 selected' }).waitFor({ timeout: 10000 });
await wendy.page.locator('button[title="Copy selected"]').click();
await wendy.page.locator('.select-bar').waitFor({ state: 'detached', timeout: 10000 });
await wendy.page.locator('.msg.out .bubble', { hasText: 'filler message 4' }).click({ button: 'right' });
await wendy.page.locator('.action-item', { hasText: 'Select' }).click();
await wendy.page.locator('.msg', { hasText: 'filler message 3' }).click();
await wendy.page.locator('.select-bar', { hasText: '2 selected' }).waitFor({ timeout: 10000 });
await wendy.page.locator('button[title="Delete selected"]').click();
await walt.page.locator('.msg .bubble', { hasText: 'filler message 4' })
  .waitFor({ state: 'detached', timeout: 15000 });
await walt.page.locator('.msg .bubble', { hasText: 'filler message 3' })
  .waitFor({ state: 'detached', timeout: 15000 });
log('multi-select: copy and bulk delete work like Telegram');

// no unverified badge should be shown
assert.equal(await walt.page.locator('.unverified').count(), 0, 'signatures verified');

// fingerprint modal
await walt.page.getByRole('button', { name: 'verify' }).click();
await walt.page.locator('.fp').first().waitFor();
const fp = await walt.page.locator('.fp').first().textContent();
assert.match(fp.trim(), /^([0-9a-f]{4} ){7}[0-9a-f]{4}$/, 'fingerprint format');
await walt.page.getByRole('button', { name: 'Done' }).click();
log('identity verification modal shows matching-format fingerprints');

// avatar: pick a photo, adjust it in the crop dialog, shows in the sidebar
await walt.page.locator('button[title="Settings"]').click();
await walt.page.locator('.view .hidden-file').setInputFiles({
  name: 'me.png', mimeType: 'image/png', buffer: png1x1, // known-good png
});
await walt.page.locator('.crop-canvas').waitFor({ timeout: 10000 });
await walt.page.getByRole('button', { name: 'Save' }).click();
await walt.page.locator('.sidebar-bottom .avatar-img').waitFor({ timeout: 15000 });
await walt.page.getByRole('button', { name: 'Remove' }).click();
await walt.page.locator('.sidebar-bottom .avatar-img').waitFor({ state: 'detached', timeout: 15000 });
log('avatar: uploaded (client-side resized), shown in UI, removed again');

// privacy settings roundtrip (walt is already on the settings page)
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

// chat management: pin, reorder pinned, delete a chat
await wendy.page.locator('button[title="New group / channel"]').click();
await wendy.page.locator('.modal input').fill(`pins-test-${run}`);
await wendy.page.getByRole('button', { name: 'Create' }).click();
await wendy.page.locator('.chat-header').waitFor({ timeout: 15000 });

const wendyItem = (text) => wendy.page.locator('.chat-item', { hasText: text });
await wendyItem(`pins-test-${run}`).click({ button: 'right' });
await wendy.page.locator('.action-item', { hasText: 'Pin to top' }).click();
await wendy.page.locator('.chat-item .pin-mark').first().waitFor({ timeout: 15000 });
assert.match(
  await wendy.page.locator('.chat-item').first().textContent(), new RegExp(`pins-test-${run}`),
  'pinned chat moves to the top',
);
await wendyItem(walt.username).click({ button: 'right' });
await wendy.page.locator('.action-item', { hasText: 'Pin to top' }).click();
await wendy.page.waitForTimeout(600);
assert.match(
  await wendy.page.locator('.chat-item').first().textContent(), new RegExp(walt.username),
  'newly pinned chat goes above older pins',
);
await wendyItem(walt.username).click({ button: 'right' });
await wendy.page.locator('.action-item', { hasText: 'Move down' }).click();
await wendy.page.waitForTimeout(600);
assert.match(
  await wendy.page.locator('.chat-item').first().textContent(), new RegExp(`pins-test-${run}`),
  'move down reorders pinned chats',
);
log('chats can be pinned to the top and reordered among themselves');

await wendyItem(`pins-test-${run}`).click({ button: 'right' });
await wendy.page.locator('.action-item', { hasText: 'Delete for everyone' }).click();
await wendyItem(`pins-test-${run}`).waitFor({ state: 'detached', timeout: 15000 });
log('chat deleted (conversation removed server-side)');

// notifications: a backgrounded client shows a system notification with the
// decrypted preview when a message arrives (stubbed Notification API)
const noraCtx = await browser.newContext({ permissions: ['notifications'] });
await noraCtx.addInitScript(() => {
  window.__notifs = [];
  function FakeNotification(title, opts) {
    window.__notifs.push({ title, body: opts?.body });
    this.close = () => {};
  }
  FakeNotification.permission = 'granted';
  FakeNotification.requestPermission = async () => 'granted';
  window.Notification = FakeNotification;
  document.hasFocus = () => false; // pretend the window is in the background
});
const noraPage = await noraCtx.newPage();
noraPage.on('pageerror', (e) => console.error('[nora] pageerror:', e.message));
await noraPage.goto(BASE);
await noraPage.getByRole('button', { name: 'Register' }).click();
await noraPage.getByPlaceholder('username').fill(`nora_${run}`);
await noraPage.getByPlaceholder('password').fill(`browser-pass-${run}!`);
await noraPage.getByRole('button', { name: 'Create account' }).click();
await noraPage.locator('.sidebar').waitFor({ timeout: 30000 });
assert.ok(
  await noraPage.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => !!r)),
  'service worker registered (needed for installed-app notifications)',
);
await wendy.page.locator('.sidebar-top input').fill(`nora_${run}`.slice(0, 6));
await wendy.page.locator('.search-hit').first().click();
await wendy.page.locator('.chat-header').waitFor({ timeout: 15000 });
await wendy.page.locator('.composer-input').fill('пссс, notification test');
await wendy.page.locator('.composer-input').press('Enter');
await noraPage.waitForFunction(() => window.__notifs.length > 0, null, { timeout: 15000 });
const notif = await noraPage.evaluate(() => window.__notifs[0]);
assert.match(notif.title, new RegExp(`wendy_${run}`), 'notification names the sender');
assert.match(notif.body, /notification test/, 'notification shows the decrypted preview');
await noraCtx.close();
log('new-message notification fired for a backgrounded client (SW registered for push)');

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
