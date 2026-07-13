'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { mapPatchToFirestore, postFromDoc, sanitizePostResult } = require('../src/postsMapper');

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

test('explicit YouTube jobs never derive account identity from TikTok-only aliases', () => {
  const restored = postFromDoc({
    id: 'malformed-youtube-job',
    data: () => ({
      provider: 'youtube',
      platform: 'youtube',
      tiktokOpenId: 'tt-placeholder',
      open_id: 'tt-placeholder'
    })
  });

  assert.equal(restored.accountId, 'legacy');
  assert.equal(restored.connectedAccountId, '');
  assert.equal(restored.tiktokOpenId, '');
  assert.equal(restored.accountAssignment, 'legacy');
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

test('canonical provider, source, approval, idempotency, and legacy status fields are normalized additively', () => {
  const restored = postFromDoc({
    id: 'runtime-job',
    data: () => ({
      platform: 'tiktok',
      provider: 'tiktok',
      creationSource: 'runtime',
      createdBy: 'mcp-client',
      correlationId: 'trace-1',
      runtimeIdempotencyKey: 'idem-1',
      status: 'publishing',
      approvedAt: null
    })
  });

  assert.equal(restored.provider, 'tiktok');
  assert.equal(restored.creationSource, 'runtime');
  assert.equal(restored.createdBy, 'mcp-client');
  assert.equal(restored.correlationId, 'trace-1');
  assert.equal(restored.idempotencyKey, 'idem-1');
  assert.equal(restored.status, 'processing');
  assert.equal(restored.approvalState, 'unapproved');
});

test('provider evidence is allowlisted and secret-shaped legacy fields never reach projections', () => {
  const restored = postFromDoc({
    id: 'unsafe-evidence-job',
    data: () => ({
      provider: 'youtube',
      history: [
        { at: '2026-07-11T12:00:00.000Z', event: 'posted', detail: 'Stored safely.' },
        { event: 'unsafe', detail: 'client_secret=HISTORY_SECRET_CANARY' }
      ],
      logs: [{ access_token: 'LOG_ACCESS_TOKEN_CANARY' }],
      events: [{ externalCustomerId: 'cus_EVENTS_BILLING_CANARY' }],
      lastResult: {
        ok: true,
        mode: 'api',
        reason: 'Uploaded. Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.SENSITIVEPAYLOADCANARY.SIGNATURECANARY externalCustomerId=cus_REASON_BILLING_CANARY',
        response: {
          video_id: 'video-safe-1',
          upload_status: 'uploaded',
          access_token: 'RESULT_ACCESS_TOKEN_CANARY',
          client_secret: 'RESULT_CLIENT_SECRET_CANARY',
          credential: { ct: 'RESULT_ENVELOPE_CANARY' },
          externalSubscriptionId: 'sub_RESULT_BILLING_CANARY',
          data: { publish_id: 'publish-safe-1', refresh_token: 'RESULT_REFRESH_TOKEN_CANARY' }
        }
      },
      lastInstagramResult: {
        ok: false,
        reason: 'client_secret=INSTAGRAM_SECRET_CANARY',
        response: { post_id: 'instagram-safe-1', access_token: 'INSTAGRAM_TOKEN_CANARY' }
      }
    })
  });

  assert.equal(restored.lastResult.response.video_id, 'video-safe-1');
  assert.equal(restored.lastResult.response.data.publish_id, 'publish-safe-1');
  assert.equal(restored.lastInstagramResult.response.post_id, 'instagram-safe-1');
  assert.equal(restored.logs, restored.history);
  const serialized = JSON.stringify(restored);
  for (const canary of [
    'HISTORY_SECRET_CANARY',
    'LOG_ACCESS_TOKEN_CANARY',
    'EVENTS_BILLING_CANARY',
    'RESULT_ACCESS_TOKEN_CANARY',
    'RESULT_CLIENT_SECRET_CANARY',
    'RESULT_ENVELOPE_CANARY',
    'RESULT_BILLING_CANARY',
    'RESULT_REFRESH_TOKEN_CANARY',
    'INSTAGRAM_SECRET_CANARY',
    'INSTAGRAM_TOKEN_CANARY',
    'SENSITIVEPAYLOADCANARY',
    'SIGNATURECANARY',
    'cus_',
    'sub_'
  ]) {
    assert.equal(serialized.includes(canary), false, canary);
  }
});

test('write patches retain safe provider IDs while dropping nested credential and billing fields', () => {
  const patch = mapPatchToFirestore({
    lastResult: {
      ok: true,
      mode: 'api',
      response: {
        data: { publish_id: 'safe-publish-id', access_token: 'WRITE_TOKEN_CANARY' },
        externalCustomerId: 'cus_WRITE_BILLING_CANARY'
      }
    }
  });
  assert.deepEqual(patch.lastResult, sanitizePostResult({
    ok: true,
    mode: 'api',
    response: { data: { publish_id: 'safe-publish-id' } }
  }));
  assert.equal(JSON.stringify(patch).includes('CANARY'), false);
});
