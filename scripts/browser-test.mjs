// Browser-level test of the web client using Playwright + system Chromium.
// Covers: import map + CSP, client-side scrypt/keygen, register, channel
// creation, E2E send/receive between two real browser contexts, privacy
// settings UI.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const BASE = process.env.PATHY_BASE_URL || 'http://localhost:8080';
const run = Math.random().toString(36).slice(2, 8);
const log = (s) => console.log(`✔ ${s}`);

const browser = await chromium.launch({
  executablePath: process.env.PW_CHROMIUM || undefined,
});

async function newUser(name) {
  const ctx = await browser.newContext();
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
await walt.page.locator('.composer input').fill('first post from the browser 📢');
await walt.page.locator('.composer input').press('Enter');
await walt.page.locator('.msg .bubble').first().waitFor({ timeout: 15000 });
assert.equal(
  await walt.page.locator('.msg .bubble').first().textContent(),
  'first post from the browser 📢',
);
log('walt created a channel and posted (E2E in browser)');

// second user DMs walt
const wendy = await newUser('wendy');
await wendy.page.locator('.sidebar-top input').fill(walt.username.slice(0, 6));
await wendy.page.locator('.search-hit').first().waitFor({ timeout: 15000 });
await wendy.page.locator('.search-hit').first().click();
await wendy.page.locator('.chat-header').waitFor({ timeout: 15000 });
await wendy.page.locator('.composer input').fill('hi walt, sent from another browser');
await wendy.page.locator('.composer input').press('Enter');
await wendy.page.locator('.msg .bubble').first().waitFor({ timeout: 15000 });
log('wendy found walt via search and sent a DM');

// walt receives it live over WS and can decrypt
await walt.page.locator('.chat-item', { hasText: `wendy_${run}` }).waitFor({ timeout: 15000 });
await walt.page.locator('.chat-item', { hasText: `wendy_${run}` }).click();
const bubble = walt.page.locator('.msg .bubble', { hasText: 'hi walt' });
await bubble.waitFor({ timeout: 15000 });
log('walt received + decrypted the DM in realtime (WS push)');

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

await browser.close();
console.log('\nALL BROWSER TESTS PASSED 🎉');
