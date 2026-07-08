// Browser checks for the newer features: replies, chunked files, video
// circles, sticker packs, image aspect ratio, scroll FAB, typing indicator.
// Also drops screenshots for visual QA into $PATHY_SHOTS_DIR (or /tmp).
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const BASE = process.env.PATHY_BASE_URL || 'http://localhost:8080';
const run = Math.random().toString(36).slice(2, 8);
const SHOTS = process.env.PATHY_SHOTS_DIR || `${process.env.TMPDIR || '/tmp'}/pathy-shots`;
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
  page.on('console', (m) => { if (m.type() === 'error') console.error(`[${name}] console.error:`, m.text()); });
  await page.goto(BASE);
  await page.getByRole('button', { name: 'Register' }).click();
  await page.getByPlaceholder('username').fill(`${name}_${run}`);
  await page.getByPlaceholder('password').fill(`browser-pass-${run}!`);
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.locator('.sidebar').waitFor({ timeout: 30000 });
  return { ctx, page, username: `${name}_${run}` };
}

const rex = await newUser('rex', { permissions: ['camera', 'microphone'] });
const kim = await newUser('kim');
kim.page.on('dialog', (d) => d.accept());
rex.page.on('dialog', (d) => d.accept());

// DM
const search = kim.page.locator('.sidebar-top input');
await search.fill(rex.username.slice(0, 6));
await kim.page.locator('.search-hit').first().click();
await kim.page.locator('.chat-header').waitFor({ timeout: 15000 });
await kim.page.locator('.composer-input').fill('привет! это тестовое сообщение');
await kim.page.locator('.composer-input').press('Enter');
await kim.page.locator('.msg.out .bubble .text').waitFor({ timeout: 15000 });

// rex opens the chat
await rex.page.locator('.chat-item', { hasText: kim.username }).click();
await rex.page.locator('.msg .bubble', { hasText: 'привет' }).waitFor({ timeout: 15000 });

// --- typing indicator: kim types, rex sees it live
await kim.page.waitForTimeout(2600); // let the client-side typing throttle expire
await kim.page.locator('.composer-input').pressSequentially('пишу ответ...', { delay: 40 });
await rex.page.locator('.chat-header .typing-text').waitFor({ timeout: 10000 });
log('typing indicator shows in the header while the other side types');
await kim.page.locator('.composer-input').fill('');

// --- reply: rex replies to kim's message via the actions menu
await rex.page.locator('.msg .bubble', { hasText: 'привет' }).click({ button: 'right' });
await rex.page.locator('.action-item', { hasText: 'Reply' }).click();
await rex.page.locator('.edit-bar', { hasText: `Reply to ${kim.username}` }).waitFor({ timeout: 10000 });
await rex.page.locator('.composer-input').fill('отвечаю на твоё сообщение');
await rex.page.locator('.composer-input').press('Enter');
const quote = kim.page.locator('.msg .reply-quote', { hasText: 'привет' });
await quote.waitFor({ timeout: 15000 });
log('reply sent — quote pinned to the message on the other side');
// click the quote → jumps & flashes the original
await quote.click();
await kim.page.locator('.msg.flash').waitFor({ timeout: 5000 });
log('clicking the quote jumps to (and highlights) the original message');

// --- multi-chunk file (10 MB > 2 chunks of 4 MB)
const big = Buffer.alloc(10 * 1024 * 1024);
for (let i = 0; i < big.length; i += 4096) big[i] = (i / 4096) & 0xff;
await kim.page.locator('.composer .hidden-file').setInputFiles({
  name: 'big-video-data.bin', mimeType: 'application/octet-stream', buffer: big,
});
const fileRow = rex.page.locator('.msg .file-row', { hasText: 'big-video-data.bin' });
await fileRow.waitFor({ timeout: 60000 });
const [download] = await Promise.all([
  rex.page.waitForEvent('download', { timeout: 60000 }),
  fileRow.locator('button.dl').click(),
]);
const path = await download.path();
const { readFileSync, mkdirSync } = await import('node:fs');
const got = readFileSync(path);
assert.equal(got.length, big.length, 'size matches');
assert.ok(got.equals(big), 'bytes match');
log('10 MB file: chunk-encrypted upload → streamed download → bytes identical');

// --- video circle: record with the fake camera and send
await rex.page.locator('.cam-btn').click();
await rex.page.locator('.round-frame video').waitFor({ timeout: 15000 });
await rex.page.waitForTimeout(1500);
await rex.page.locator('.round-controls .send-btn').click();
await rex.page.locator('.msg.out .round-wrap').waitFor({ timeout: 60000 });
const kimRound = kim.page.locator('.msg .round-wrap');
await kimRound.waitFor({ timeout: 60000 });
await kimRound.click();
await kim.page.locator('.round-wrap.playing').waitFor({ timeout: 15000 });
log('video circle: recorded, encrypted, sent; receiver plays it in a circle');

// --- sticker manager opens; custom pack creation
await kim.page.locator('button[title="Emoji & stickers"]').click();
await kim.page.locator('.picker-tab', { hasText: 'Stickers' }).click();
await kim.page.locator('.pack-bar').waitFor({ timeout: 10000 });
await kim.page.locator('button[title="Manage sticker packs"]').click();
await kim.page.locator('.modal', { hasText: 'Import a Telegram pack' }).waitFor({ timeout: 10000 });
await kim.page.locator('input[placeholder="New pack name"]').fill('My test pack');
await kim.page.getByRole('button', { name: 'Create' }).click();
await kim.page.locator('.modal', { hasText: 'My test pack' }).waitFor({ timeout: 10000 });
// upload a sticker image (16x16 png)
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAFklEQVR42mP8z8BQz0AEYBxVSF+FAP5FDvcfRYWgAAAAAElFTkSuQmCC', 'base64');
await kim.page.locator('.modal .hidden-file').setInputFiles({ name: 's.png', mimeType: 'image/png', buffer: png });
await kim.page.locator('.modal .sticker-cell.edit').waitFor({ timeout: 20000 });
await kim.page.getByRole('button', { name: 'Done' }).click();
// pick it from the picker and send (picker may still be open from before)
if (!(await kim.page.locator('.picker').isVisible())) {
  await kim.page.locator('button[title="Emoji & stickers"]').click();
}
await kim.page.locator('.picker-tab', { hasText: 'Stickers' }).click();
await kim.page.locator('.pack-btn').last().click();
await kim.page.locator('.picker .sticker-cell .sticker-img').first().waitFor({ timeout: 15000 });
await kim.page.locator('.picker .sticker-cell').first().click();
await kim.page.locator('.msg.out .sticker-img-big').waitFor({ timeout: 20000 });
// rex sees it and can open the pack modal to install
const rexSticker = rex.page.locator('.msg .sticker-img-big');
await rexSticker.waitFor({ timeout: 20000 });
await rexSticker.click();
await rex.page.locator('.modal', { hasText: 'My test pack' }).waitFor({ timeout: 10000 });
await rex.page.getByRole('button', { name: 'Add stickers' }).click();
await rex.page.locator('.toast', { hasText: 'added to your stickers' }).waitFor({ timeout: 10000 });
log('custom sticker pack: created, sticker uploaded, sent, installed by the receiver');

// --- image aspect ratio: send a wide image, bubble must hug it
const widePng = await kim.page.evaluate(async () => {
  const c = document.createElement('canvas');
  c.width = 400; c.height = 100;
  const g = c.getContext('2d');
  g.fillStyle = '#3390ec'; g.fillRect(0, 0, 400, 100);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  return Array.from(new Uint8Array(await blob.arrayBuffer()));
});
await kim.page.locator('.composer .hidden-file').setInputFiles({
  name: 'wide.png', mimeType: 'image/png', buffer: Buffer.from(widePng),
});
const img = rex.page.locator('.msg .img-attach').first();
await img.waitFor({ timeout: 30000 });
const dims = await img.evaluate((el) => ({ w: el.clientWidth, h: el.clientHeight }));
const ratio = dims.w / dims.h;
assert.ok(Math.abs(ratio - 4) < 0.2, `bubble image keeps 4:1 aspect (got ${ratio.toFixed(2)})`);
log(`image bubble hugs the aspect ratio (rendered ${dims.w}x${dims.h})`);

// --- scroll FAB appears when scrolled up
for (let i = 0; i < 8; i++) {
  await kim.page.locator('.composer-input').fill(`наполняем историю сообщением номер ${i}`);
  await kim.page.locator('.composer-input').press('Enter');
}
await rex.page.locator('.msg .bubble', { hasText: 'номер 7' }).waitFor({ timeout: 15000 });
await rex.page.locator('.messages').evaluate((el) => { el.scrollTop = 0; });
await rex.page.locator('.fab.show').waitFor({ timeout: 5000 });
await rex.page.locator('.fab').click();
await rex.page.waitForFunction(() => {
  const el = document.querySelector('.messages');
  return el.scrollHeight - el.scrollTop - el.clientHeight < 60;
}, null, { timeout: 5000 });
log('scroll-to-latest FAB appears when scrolled up and jumps to the bottom');

// --- screenshots for visual QA
mkdirSync(SHOTS, { recursive: true });
await rex.page.screenshot({ path: `${SHOTS}/desktop-chat.png` });
const mia = await newUser('mia', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await mia.page.screenshot({ path: `${SHOTS}/mobile-list.png` });
const miaSearch = mia.page.locator('.sidebar-top input');
await miaSearch.tap();
await miaSearch.pressSequentially(rex.username.slice(0, 6), { delay: 50 });
await mia.page.locator('.search-hit').first().tap();
await mia.page.locator('.chat-header').waitFor({ timeout: 15000 });
await mia.page.locator('.composer-input').fill('привет с телефона');
await mia.page.locator('.composer-input').press('Enter');
await mia.page.locator('.msg.out .bubble').waitFor({ timeout: 15000 });
await mia.page.screenshot({ path: `${SHOTS}/mobile-chat.png` });
log(`screenshots saved to ${SHOTS}`);

await browser.close();
console.log('\nALL NEW-FEATURE UI TESTS PASSED 🎉');
