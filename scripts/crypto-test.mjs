// Unit roundtrip test for shared/crypto.js — run from server/ so the @noble
// imports resolve:  node --experimental-vm-modules ../scripts/crypto-test.mjs
import assert from 'node:assert/strict';
import * as C from '../shared/crypto.js';

// identity + bundle
const alice = C.generateIdentity();
const bob = C.generateIdentity();
const aliceBundle = C.makePublicBundle(alice, 'u:alice');
const bobBundle = C.makePublicBundle(bob, 'u:bob');
assert.ok(C.verifyPublicBundle(aliceBundle, 'u:alice'), 'bundle verifies');
assert.equal(C.verifyPublicBundle(aliceBundle, 'u:eve'), null, 'bundle bound to name');
const tampered = { ...aliceBundle, kem: bobBundle.kem };
assert.equal(C.verifyPublicBundle(tampered, 'u:alice'), null, 'kem swap detected');
console.log('bundle ok, fingerprint:', C.fingerprint(aliceBundle, 'u:alice'));

// password login keys + backup
const salt = C.newSalt();
const { authKey, backupKey } = C.deriveLoginKeys('correct horse battery staple', salt);
assert.equal(C.fromB64(authKey).length, 32);
const blob = C.encryptBackup(backupKey, alice, 'alice');
const restored = C.decryptBackup(backupKey, blob, 'alice');
assert.deepEqual(restored.dsaPublic, alice.dsaPublic, 'backup restores identity');
const { backupKey: wrongKey } = C.deriveLoginKeys('wrong password', salt);
assert.throws(() => C.decryptBackup(wrongKey, blob, 'alice'), 'wrong password fails');
console.log('backup ok');

// envelope wrap/unwrap
const scope = C.dmScope('u:alice', 'u:bob');
assert.equal(scope, C.dmScope('u:bob', 'u:alice'), 'dm scope is order independent');
const convKey = C.newConversationKey();
const env = C.wrapKey(convKey, scope, 1, 'u:bob', C.fromB64(bobBundle.kem), 'u:alice', alice);
const got = C.unwrapKey(env, scope, 1, 'u:bob', bob, C.fromB64(aliceBundle.dsa));
assert.deepEqual(got, convKey, 'envelope roundtrip');
assert.throws(() => C.unwrapKey(env, 'room:other', 1, 'u:bob', bob, C.fromB64(aliceBundle.dsa)), 'wrong scope rejected');
assert.throws(() => C.unwrapKey(env, scope, 2, 'u:bob', bob, C.fromB64(aliceBundle.dsa)), 'wrong version rejected');
assert.throws(() => C.unwrapKey(env, scope, 1, 'u:bob', bob, C.fromB64(bobBundle.dsa)), 'wrong signer rejected');
console.log('envelope ok');

// message encrypt/decrypt
const sent = C.encryptMessage(convKey, 42, 1, 'u:alice', alice, { t: 'text', text: 'привет, bob! 🚀' });
const rcv = C.decryptMessage(convKey, 42, { ...sent, senderRef: 'u:alice' }, C.fromB64(aliceBundle.dsa));
assert.equal(rcv.body.text, 'привет, bob! 🚀');
assert.equal(rcv.verified, true);
// spoofed sender ref breaks both AAD and signature
assert.throws(() => C.decryptMessage(convKey, 42, { ...sent, senderRef: 'u:eve' }, null), 'sender spoof rejected');
// replay into other conversation rejected
assert.throws(() => C.decryptMessage(convKey, 7, { ...sent, senderRef: 'u:alice' }, null), 'cross-conv replay rejected');
console.log('message ok');

console.log('ALL CRYPTO TESTS PASSED');
