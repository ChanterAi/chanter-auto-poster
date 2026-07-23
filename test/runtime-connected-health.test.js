'use strict';
// SPEC TEST — authored by the CHANTER Local Evolution Worker's deterministic
// core (NOT the model). Defines correctness for runtime.connected-health.
// Uses dependency injection so it needs no real Firestore / node_modules.
const { test } = require('node:test');
const assert = require('node:assert');
const { readConnectedHealth } = require('../src/runtimeConnectedHealth');

// Records every (collection, docId) touched so tests can assert the probe uses
// a real, non-reserved document id — the failure that a naive __..__ id causes
// only against a real backend, invisible to a fake that resolves any id.
function fakeFirestore(behavior, calls) {
  const sink = calls || [];
  return { collection(name) { return { doc(id) { sink.push({ collection: name, id: id }); return { get() {
    if (behavior === 'reject') return Promise.reject(new Error('backend unavailable'));
    if (behavior === 'hang') return new Promise(() => {});
    // A real Firestore rejects ids matching /^__.*__$/ with INVALID_ARGUMENT.
    if (/^__.*__$/.test(String(id))) return Promise.reject(new Error('INVALID_ARGUMENT: reserved id'));
    return Promise.resolve({ exists: false, data: () => ({}) });
  } }; } }; } };
}

test('emulator mode: reachable read reports emulator + ISO observedAt', async () => {
  const h = await readConnectedHealth({ getFirestore: () => fakeFirestore('ok'), configured: true, emulatorHost: '127.0.0.1:8080', timeoutMs: 1000 });
  assert.strictEqual(h.storage.provider, 'firestore');
  assert.strictEqual(h.storage.mode, 'emulator');
  assert.strictEqual(h.storage.reachable, true);
  assert.strictEqual(h.ok, true);
  assert.strictEqual(typeof h.observedAt, 'string');
  assert.match(h.observedAt, /^\d{4}-\d{2}-\d{2}T.*Z$/);
});

test('real mode: reachable read, no emulator host', async () => {
  const h = await readConnectedHealth({ getFirestore: () => fakeFirestore('ok'), configured: true, emulatorHost: '', timeoutMs: 1000 });
  assert.strictEqual(h.storage.mode, 'real');
  assert.strictEqual(h.storage.reachable, true);
  assert.strictEqual(h.ok, true);
});

test('unavailable: backend read rejects', async () => {
  const h = await readConnectedHealth({ getFirestore: () => fakeFirestore('reject'), configured: true, emulatorHost: '127.0.0.1:8080', timeoutMs: 1000 });
  assert.strictEqual(h.storage.mode, 'unavailable');
  assert.strictEqual(h.storage.reachable, false);
  assert.strictEqual(h.ok, false);
});

test('unavailable: read hangs past timeout', async () => {
  const started = Date.now();
  const h = await readConnectedHealth({ getFirestore: () => fakeFirestore('hang'), configured: true, emulatorHost: '', timeoutMs: 150 });
  assert.ok(Date.now() - started < 2000, 'must resolve near timeout, not hang');
  assert.strictEqual(h.storage.mode, 'unavailable');
  assert.strictEqual(h.storage.reachable, false);
});

test('unknown: not configured -> never touches Firestore', async () => {
  let called = false;
  const h = await readConnectedHealth({ getFirestore: () => { called = true; throw new Error('must not be called'); }, configured: false, emulatorHost: '', timeoutMs: 1000 });
  assert.strictEqual(called, false);
  assert.strictEqual(h.storage.mode, 'unknown');
  assert.strictEqual(h.ok, false);
});

test('never throws and leaks no raw error text', async () => {
  const h = await readConnectedHealth({ getFirestore: () => fakeFirestore('reject'), configured: true, emulatorHost: '', timeoutMs: 500 });
  const serialized = JSON.stringify(h);
  assert.ok(!/backend unavailable/.test(serialized), 'raw error text must not leak into payload');
});

test('probe uses a valid, non-reserved Firestore document id (real-backend safe)', async () => {
  const calls = [];
  const h = await readConnectedHealth({ getFirestore: () => fakeFirestore('ok', calls), configured: true, emulatorHost: '127.0.0.1:8080', timeoutMs: 1000 });
  assert.ok(calls.length >= 1, 'must perform at least one read');
  for (const c of calls) {
    assert.ok(!/^__.*__$/.test(String(c.id)), 'probe document id must not be a reserved __..__ id: ' + c.id);
  }
  // With a valid id the fake resolves, so a healthy backend reads as reachable.
  assert.strictEqual(h.storage.mode, 'emulator');
  assert.strictEqual(h.storage.reachable, true);
});
