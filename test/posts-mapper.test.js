'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { mapPatchToFirestore, postFromDoc } = require('../src/postsMapper');

test('scheduledAt is stored and restored as one absolute UTC instant', () => {
  const iso = '2026-06-20T09:15:00.000Z';
  const patch = mapPatchToFirestore({ scheduledAt: iso });

  assert.equal(patch.scheduledAt.toDate().toISOString(), iso);
  assert.equal('scheduledTimeUTC' in patch, false);

  const restored = postFromDoc({
    id: 'timezone-job',
    data: () => ({ status: 'scheduled', scheduledAt: patch.scheduledAt })
  });
  assert.equal(restored.scheduledAt, iso);
  assert.equal(restored.accountId, 'legacy');
  assert.equal(restored.accountAssignment, 'legacy');
});

test('preserves TikTok account ownership fields on jobs', () => {
  const restored = postFromDoc({
    id: 'account-job',
    data: () => ({
      userId: 'owner',
      platform: 'tiktok',
      accountId: 'account-b',
      tiktokOpenId: 'account-b',
      username: 'account_b'
    })
  });

  assert.equal(restored.accountId, 'account-b');
  assert.equal(restored.tiktokOpenId, 'account-b');
  assert.equal(restored.username, 'account_b');
  assert.equal(restored.accountAssignment, 'assigned');
});

test('legacy scheduledTimeUTC remains readable during queue migration', () => {
  const iso = '2026-06-20T09:15:00.000Z';
  const restored = postFromDoc({
    id: 'legacy-job',
    data: () => ({
      status: 'pending',
      scheduledTimeUTC: { toDate: () => new Date(iso) }
    })
  });
  assert.equal(restored.scheduledAt, iso);
});
