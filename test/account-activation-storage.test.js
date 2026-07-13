'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

class MemorySnapshot {
  constructor(id, data) {
    this.id = id;
    this.exists = data !== undefined;
    this.value = clone(data);
  }

  data() {
    return clone(this.value);
  }
}

class MemoryDocumentReference {
  constructor(db, collectionName, id) {
    this.db = db;
    this.collectionName = collectionName;
    this.id = id;
    this.path = `${collectionName}/${id}`;
  }

  async get() {
    // Yield once so non-transactional read/write implementations expose the
    // race under Promise.all instead of accidentally running sequentially.
    await Promise.resolve();
    return new MemorySnapshot(this.id, this.db.get(this.collectionName, this.id));
  }

  async set(data, options = {}) {
    await Promise.resolve();
    this.db.set(this.collectionName, this.id, data, options);
  }
}

class MemoryQuery {
  constructor(db, collectionName, predicates = [], limitValue = null) {
    this.db = db;
    this.collectionName = collectionName;
    this.predicates = predicates;
    this.limitValue = limitValue;
  }

  where(field, operator, value) {
    assert.equal(operator, '==');
    return new MemoryQuery(
      this.db,
      this.collectionName,
      [...this.predicates, { field, value }],
      this.limitValue
    );
  }

  limit(value) {
    return new MemoryQuery(this.db, this.collectionName, this.predicates, value);
  }

  async get() {
    return this.db.query(this);
  }
}

class MemoryCollection {
  constructor(db, name) {
    this.db = db;
    this.name = name;
  }

  doc(id) {
    return new MemoryDocumentReference(this.db, this.name, id);
  }

  where(field, operator, value) {
    return new MemoryQuery(this.db, this.name).where(field, operator, value);
  }

  limit(value) {
    return new MemoryQuery(this.db, this.name, [], value);
  }
}

class MemoryTransaction {
  constructor(db) {
    this.db = db;
    this.writes = [];
  }

  async get(reference) {
    if (this.writes.length) throw new Error('transaction read after write');
    if (reference instanceof MemoryQuery) return this.db.query(reference);
    return new MemorySnapshot(
      reference.id,
      this.db.get(reference.collectionName, reference.id)
    );
  }

  set(reference, data, options = {}) {
    this.writes.push({ reference, data: clone(data), options });
  }

  commit() {
    for (const write of this.writes) {
      this.db.set(
        write.reference.collectionName,
        write.reference.id,
        write.data,
        write.options
      );
    }
  }
}

class MemoryFirestore {
  constructor() {
    this.collections = new Map();
    this.transactionTail = Promise.resolve();
  }

  records(name) {
    if (!this.collections.has(name)) this.collections.set(name, new Map());
    return this.collections.get(name);
  }

  collection(name) {
    return new MemoryCollection(this, name);
  }

  get(collectionName, id) {
    return clone(this.records(collectionName).get(id));
  }

  set(collectionName, id, data, options = {}) {
    const records = this.records(collectionName);
    records.set(id, options.merge
      ? { ...(records.get(id) || {}), ...clone(data) }
      : clone(data));
  }

  query(query) {
    let docs = [...this.records(query.collectionName).entries()]
      .filter(([, data]) => query.predicates.every(({ field, value }) => data[field] === value))
      .map(([id, data]) => new MemorySnapshot(id, data));
    if (query.limitValue !== null) docs = docs.slice(0, query.limitValue);
    return { docs, empty: docs.length === 0, size: docs.length };
  }

  runTransaction(callback) {
    const execute = async () => {
      const transaction = new MemoryTransaction(this);
      const result = await callback(transaction);
      transaction.commit();
      return result;
    };
    const pending = this.transactionTail.then(execute, execute);
    this.transactionTail = pending.catch(() => {});
    return pending;
  }
}

function installStorage() {
  const firestorePath = require.resolve('../src/firestore');
  const cloudinaryPath = require.resolve('../src/cloudinary');
  const storagePath = require.resolve('../src/storage');
  const mapperPath = require.resolve('../src/postsMapper');
  for (const modulePath of [firestorePath, cloudinaryPath, storagePath, mapperPath]) {
    delete require.cache[modulePath];
  }

  const db = new MemoryFirestore();
  let tick = 0;
  const timestamp = () => ({ value: ++tick });
  const collection = (name) => () => db.collection(name);

  require.cache[firestorePath] = {
    id: firestorePath,
    filename: firestorePath,
    loaded: true,
    exports: {
      postsCollection: collection('posts'),
      tiktokAccountsCollection: collection('tiktokAccounts'),
      youtubeAccountsCollection: collection('youtubeAccounts'),
      connectedAccountCapacityCollection: collection('connectedAccountCapacity'),
      configDoc: (name) => db.collection('config').doc(name),
      getFirestore: () => db,
      Timestamp: { now: timestamp, fromDate: timestamp },
      FieldValue: { serverTimestamp: timestamp, increment: (value) => value }
    }
  };
  require.cache[cloudinaryPath] = {
    id: cloudinaryPath,
    filename: cloudinaryPath,
    loaded: true,
    exports: {
      uploadMediaFile: async () => ({}),
      destroyMediaAsset: async () => {},
      checkCloudinaryHealth: async () => ({ ok: true })
    }
  };

  return {
    db,
    storage: require('../src/storage'),
    cleanup() {
      for (const modulePath of [firestorePath, cloudinaryPath, storagePath, mapperPath]) {
        delete require.cache[modulePath];
      }
    }
  };
}

function scope(workspaceId, allowLegacyOwnerRecords = false) {
  return { workspaceId, allowLegacyOwnerRecords };
}

function activation(ownerUserId, workspaceId, provider, limits = {}) {
  return {
    ownerUserId,
    workspaceId,
    provider,
    connectedAccountLimit: limits.connectedAccountLimit ?? 20,
    providerLimit: limits.providerLimit ?? 4
  };
}

function tiktokAuth(accountId, suffix = '') {
  return {
    open_id: accountId,
    access_token: `access-${accountId}${suffix}`,
    refresh_token: `refresh-${accountId}${suffix}`,
    scope: 'video.publish'
  };
}

function youtubeInput(channelId, suffix = '') {
  return {
    channelId,
    profile: { title: `Channel ${channelId}`, handle: `@${channelId}` },
    credentialEnvelope: { v: 1, kv: 1, iv: 'iv', tag: 'tag', ct: `cipher${suffix}` },
    tokenMeta: {
      tokenPresent: true,
      refreshTokenPresent: true,
      grantedScopes: 'https://www.googleapis.com/auth/youtube.upload'
    }
  };
}

function capacity(db, workspaceId) {
  return db.get('connectedAccountCapacity', encodeURIComponent(workspaceId));
}

test('concurrent TikTok callbacks cannot rebind one provider identity across owners or workspaces', async (t) => {
  const { db, storage, cleanup } = installStorage();
  t.after(cleanup);

  const results = await Promise.allSettled([
    storage.saveTikTokAccount(
      'owner-a', tiktokAuth('shared'), {}, scope('workspace-a'),
      activation('owner-a', 'workspace-a', 'tiktok')
    ),
    storage.saveTikTokAccount(
      'owner-b', tiktokAuth('shared'), {}, scope('workspace-b'),
      activation('owner-b', 'workspace-b', 'tiktok')
    )
  ]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const denied = results.find((result) => result.status === 'rejected').reason;
  assert.equal(denied.code, 'account_already_assigned');
  const saved = db.get('tiktokAccounts', 'shared');
  assert.ok(['owner-a', 'owner-b'].includes(saved.userId));
  assert.equal(saved.workspaceId, saved.userId === 'owner-a' ? 'workspace-a' : 'workspace-b');
});

test('concurrent YouTube callbacks cannot rebind one channel across owners or workspaces', async (t) => {
  const { db, storage, cleanup } = installStorage();
  t.after(cleanup);

  const results = await Promise.allSettled([
    storage.saveYouTubeAccount(
      'owner-a', youtubeInput('UC-shared', '-a'), scope('workspace-a'),
      activation('owner-a', 'workspace-a', 'youtube')
    ),
    storage.saveYouTubeAccount(
      'owner-b', youtubeInput('UC-shared', '-b'), scope('workspace-b'),
      activation('owner-b', 'workspace-b', 'youtube')
    )
  ]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'account_already_assigned');
  assert.equal(db.records('youtubeAccounts').size, 1);
});

test('concurrent distinct TikTok activations cannot overrun connectedAccountLimit', async (t) => {
  const { db, storage, cleanup } = installStorage();
  t.after(cleanup);
  const limits = { connectedAccountLimit: 1, providerLimit: 1 };

  const results = await Promise.allSettled(['a', 'b'].map((id) => storage.saveTikTokAccount(
    'owner', tiktokAuth(id), {}, scope('workspace'), activation('owner', 'workspace', 'tiktok', limits)
  )));

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const denied = results.find((result) => result.status === 'rejected').reason;
  assert.equal(denied.code, 'connected_account_limit_reached');
  assert.match(denied.message, /Current: 1\. Limit: 1\./);
  assert.doesNotMatch(
    `${denied.message} ${JSON.stringify(denied.details)}`,
    /access-|refresh-|cipher/,
    'limit denials contain no provider credential material'
  );
  assert.equal(db.records('tiktokAccounts').size, 1, 'denied credentials were never persisted');
  assert.equal(capacity(db, 'workspace').connectedAccountCount, 1);
});

test('concurrent TikTok and YouTube activations cannot overrun providerLimit', async (t) => {
  const { db, storage, cleanup } = installStorage();
  t.after(cleanup);
  const limits = { connectedAccountLimit: 5, providerLimit: 1 };

  const results = await Promise.allSettled([
    storage.saveTikTokAccount(
      'owner', tiktokAuth('tt'), {}, scope('workspace'),
      activation('owner', 'workspace', 'tiktok', limits)
    ),
    storage.saveYouTubeAccount(
      'owner', youtubeInput('UC-yt'), scope('workspace'),
      activation('owner', 'workspace', 'youtube', limits)
    )
  ]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'provider_limit_reached');
  assert.equal(capacity(db, 'workspace').activeProviderIds.length, 1);
});

test('TikTok reconnect is idempotent and disconnect atomically releases capacity', async (t) => {
  const { db, storage, cleanup } = installStorage();
  t.after(cleanup);
  const limits = { connectedAccountLimit: 1, providerLimit: 1 };
  const context = activation('owner', 'workspace', 'tiktok', limits);

  await Promise.all([
    storage.saveTikTokAccount('owner', tiktokAuth('first', '-one'), {}, scope('workspace'), context),
    storage.saveTikTokAccount('owner', tiktokAuth('first', '-two'), {}, scope('workspace'), context)
  ]);
  assert.equal(capacity(db, 'workspace').connectedAccountCount, 1);

  assert.equal(await storage.disconnectTikTokAccount('owner', 'first', scope('workspace')), true);
  assert.equal(capacity(db, 'workspace').connectedAccountCount, 0);
  await storage.saveTikTokAccount(
    'owner', tiktokAuth('second'), {}, scope('workspace'), context
  );
  assert.equal(capacity(db, 'workspace').connectedAccountCount, 1);
  assert.equal(db.get('tiktokAccounts', 'first').connected, false);
  assert.equal(db.get('tiktokAccounts', 'second').connected, true);
});

test('YouTube reconnect is idempotent and disconnect atomically releases capacity', async (t) => {
  const { db, storage, cleanup } = installStorage();
  t.after(cleanup);
  const limits = { connectedAccountLimit: 1, providerLimit: 1 };
  const context = activation('owner', 'workspace', 'youtube', limits);

  await Promise.all([
    storage.saveYouTubeAccount('owner', youtubeInput('UC-first', '-one'), scope('workspace'), context),
    storage.saveYouTubeAccount('owner', youtubeInput('UC-first', '-two'), scope('workspace'), context)
  ]);
  assert.equal(capacity(db, 'workspace').connectedAccountCount, 1);

  assert.equal(await storage.disconnectYouTubeAccount('owner', 'UC-first', scope('workspace')), true);
  assert.equal(capacity(db, 'workspace').connectedAccountCount, 0);
  await storage.saveYouTubeAccount(
    'owner', youtubeInput('UC-second'), scope('workspace'), context
  );
  assert.equal(capacity(db, 'workspace').connectedAccountCount, 1);
  assert.equal(db.get('youtubeAccounts', 'UC-first').tokenPresent, false);
  assert.equal(db.get('youtubeAccounts', 'UC-second').tokenPresent, true);
});

test('verified legacy accounts seed capacity and only bind to the verified default workspace', async (t) => {
  const { db, storage, cleanup } = installStorage();
  t.after(cleanup);
  db.set('tiktokAccounts', 'legacy-real', {
    userId: 'owner',
    workspaceId: '',
    platform: 'tiktok',
    accountId: 'legacy-real',
    open_id: 'legacy-real',
    connected: true,
    access_token: 'legacy-access',
    refresh_token: 'legacy-refresh'
  });

  assert.equal(
    await storage.getTikTokAccount('owner', 'legacy-real', scope('workspace-b')),
    null,
    'an unverified workspace cannot read a legacy owner record'
  );
  assert.equal(
    (await storage.getTikTokAccount('owner', 'legacy-real', scope('workspace-default', true))).accountId,
    'legacy-real',
    'only the verified default workspace may adopt legacy owner records'
  );

  await assert.rejects(
    storage.saveYouTubeAccount(
      'owner', youtubeInput('UC-new'), scope('workspace-default', true),
      activation('owner', 'workspace-default', 'youtube', {
        connectedAccountLimit: 1,
        providerLimit: 2
      })
    ),
    (error) => error.code === 'connected_account_limit_reached'
  );
  assert.equal(db.records('youtubeAccounts').size, 0);

  await storage.saveTikTokAccount(
    'owner', tiktokAuth('legacy-real', '-new'), {}, scope('workspace-default', true),
    activation('owner', 'workspace-default', 'tiktok', {
      connectedAccountLimit: 1,
      providerLimit: 1
    })
  );
  assert.equal(db.get('tiktokAccounts', 'legacy-real').workspaceId, 'workspace-default');
  assert.equal(capacity(db, 'workspace-default').connectedAccountCount, 1);
  assert.equal(
    await storage.getTikTokAccount('owner', 'legacy-real', scope('workspace-b')),
    null,
    'canonical workspace A records remain isolated from workspace B'
  );

  await assert.rejects(
    storage.saveTikTokAccount(
      'owner', tiktokAuth('legacy-real'), {}, scope('other-workspace'),
      activation('owner', 'other-workspace', 'tiktok')
    ),
    (error) => error.code === 'account_already_assigned'
  );
});
