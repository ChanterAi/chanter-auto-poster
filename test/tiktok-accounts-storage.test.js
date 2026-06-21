'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

test('stores and disconnects TikTok accounts independently by open_id', async (t) => {
  const firestorePath = require.resolve('../src/firestore');
  const storagePath = require.resolve('../src/storage');
  const mapperPath = require.resolve('../src/postsMapper');
  for (const modulePath of [firestorePath, storagePath, mapperPath]) delete require.cache[modulePath];

  const accountDocs = new Map();
  let tick = 0;
  const timestamp = () => ({
    value: ++tick,
    toMillis() { return this.value; },
    toDate() { return new Date(this.value); }
  });
  const snapshot = (id) => ({
    id,
    get exists() { return accountDocs.has(id); },
    data: () => accountDocs.get(id)
  });
  const accountRef = (id) => ({
    id,
    get: async () => snapshot(id),
    set: async (data, options = {}) => {
      accountDocs.set(id, options.merge ? { ...(accountDocs.get(id) || {}), ...data } : data);
    }
  });
  const accountsCollection = {
    doc: accountRef,
    where: (field, operator, value) => ({
      get: async () => ({
        docs: [...accountDocs.keys()].map(snapshot).filter((doc) => doc.data()[field] === value)
      })
    })
  };

  require.cache[firestorePath] = {
    id: firestorePath,
    filename: firestorePath,
    loaded: true,
    exports: {
      postsCollection: () => ({}),
      tiktokAccountsCollection: () => accountsCollection,
      configDoc: () => ({ get: async () => ({ exists: false, data: () => ({}) }) }),
      getFirestore: () => ({}),
      Timestamp: { now: timestamp, fromDate: timestamp },
      FieldValue: { serverTimestamp: timestamp, increment: (value) => value }
    }
  };

  t.after(() => {
    for (const modulePath of [firestorePath, storagePath, mapperPath]) delete require.cache[modulePath];
  });

  const storage = require('../src/storage');
  await storage.saveTikTokAccount('owner', {
    open_id: 'account-a', access_token: 'token-a', refresh_token: 'refresh-a', scope: 'video.publish'
  }, { username: 'account_a' });
  await storage.saveTikTokAccount('owner', {
    open_id: 'account-b', access_token: 'token-b', refresh_token: 'refresh-b', scope: 'video.publish'
  }, { username: 'account_b' });

  let accounts = await storage.getTikTokAccounts('owner');
  assert.deepEqual(accounts.map((account) => account.accountId).sort(), ['account-a', 'account-b']);
  assert.equal((await storage.getTikTokAccount('owner', 'account-a')).access_token, 'token-a');
  assert.equal((await storage.getTikTokAccount('owner', 'account-b')).access_token, 'token-b');

  await storage.disconnectTikTokAccount('owner', 'account-a');
  accounts = await storage.getTikTokAccounts('owner');
  const accountA = accounts.find((account) => account.accountId === 'account-a');
  const accountB = accounts.find((account) => account.accountId === 'account-b');
  assert.equal(accountA.connected, false);
  assert.equal(accountA.access_token, '');
  assert.equal(accountB.connected, true);
  assert.equal(accountB.access_token, 'token-b');
  assert.equal(accountDocs.size, 2);
});
