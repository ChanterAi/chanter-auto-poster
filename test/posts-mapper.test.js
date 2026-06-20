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
