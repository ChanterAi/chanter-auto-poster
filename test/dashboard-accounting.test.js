'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const accountingPromise = import('../src/pages/dashboard-accounting.mjs');

const accounts = [
  {
    id: 'account-a',
    accountId: 'account-a',
    open_id: 'open-a',
    username: 'account_a',
    displayName: 'Account A',
    connected: true
  },
  {
    id: 'account-b',
    accountId: 'account-b',
    open_id: 'open-b',
    username: 'account_b',
    displayName: 'Account B',
    connected: false
  }
];

test('assigns jobs only when account references resolve deterministically', async () => {
  const { assignDashboardJobs, UNASSIGNED_ACCOUNT_ID } = await accountingPromise;
  const jobs = assignDashboardJobs([
    { id: 'by-account-id', accountId: 'account-a' },
    { id: 'by-open-id', tiktokOpenId: 'open-b' },
    { id: 'by-username', username: '@ACCOUNT_A' },
    { id: 'by-nested-account', account: { open_id: 'open-b' } },
    { id: 'by-string-account', account: 'account_a' },
    { id: 'without-reference' },
    { id: 'unknown-reference', accountId: 'missing-account' },
    { id: 'conflicting-ids', accountId: 'account-a', tiktokOpenId: 'open-b' }
  ], accounts);

  assert.deepEqual(jobs.map((job) => job.accountId), [
    'account-a',
    'account-b',
    'account-a',
    'account-b',
    'account-a',
    UNASSIGNED_ACCOUNT_ID,
    UNASSIGNED_ACCOUNT_ID,
    UNASSIGNED_ACCOUNT_ID
  ]);
  assert.equal(jobs[0].accountAssignment, 'deterministic');
  assert.equal(jobs[5].accountAssignment, 'unassigned');
});

test('does not guess when a username matches more than one account', async () => {
  const { assignDashboardJobs, UNASSIGNED_ACCOUNT_ID } = await accountingPromise;
  const duplicateUsernameAccounts = [
    ...accounts,
    { id: 'account-c', open_id: 'open-c', username: 'ACCOUNT_A', connected: true }
  ];

  const [job] = assignDashboardJobs([{ id: 'ambiguous', username: 'account_a' }], duplicateUsernameAccounts);
  assert.equal(job.accountId, UNASSIGNED_ACCOUNT_ID);
});

test('groups account jobs in account order and puts unassigned jobs last', async () => {
  const { assignDashboardJobs, groupDashboardJobs, UNASSIGNED_ACCOUNT_ID } = await accountingPromise;
  const assignedJobs = assignDashboardJobs([
    { id: 'b-1', accountId: 'account-b' },
    { id: 'legacy-1' },
    { id: 'a-1', username: 'account_a' },
    { id: 'a-2', tiktokOpenId: 'open-a' }
  ], accounts);
  const groups = groupDashboardJobs(assignedJobs, accounts);

  assert.deepEqual(groups.map((group) => group.account?.id || UNASSIGNED_ACCOUNT_ID), [
    'account-a',
    'account-b',
    UNASSIGNED_ACCOUNT_ID
  ]);
  assert.deepEqual(groups.map((group) => group.jobs.length), [2, 1, 1]);
  assert.deepEqual(groups[0].jobs.map((job) => job.id), ['a-1', 'a-2']);
});

test('summarizes campaigns from job campaign fields without inventing data', async () => {
  const { summarizeDashboardCampaigns } = await accountingPromise;
  const campaigns = summarizeDashboardCampaigns([
    { id: 'a-1', campaignId: 'cmp-1111-2222', campaignJobStatus: 'posted', status: 'posted' },
    { id: 'a-2', campaignId: 'cmp-1111-2222', campaignJobStatus: 'retry_required', status: 'failed' },
    { id: 'b-1', campaignId: 'cmp-9999-8888', campaignJobStatus: 'failed', status: 'failed' },
    { id: 'fallback', campaignId: 'cmp-9999-8888', campaignJobStatus: '', status: 'scheduled' },
    { id: 'standalone', campaignId: '', status: 'scheduled' },
    { id: 'no-campaign-field', status: 'posted' }
  ]);

  assert.deepEqual(campaigns, [
    {
      campaignId: 'cmp-1111-2222',
      jobCount: 2,
      statusCounts: { posted: 1, retry_required: 1 },
      hasFailures: false,
      hasRetryRequired: true
    },
    {
      campaignId: 'cmp-9999-8888',
      jobCount: 2,
      statusCounts: { failed: 1, scheduled: 1 },
      hasFailures: true,
      hasRetryRequired: false
    }
  ]);
});

test('summarizes zero campaigns for standalone jobs and bad input', async () => {
  const { summarizeDashboardCampaigns } = await accountingPromise;
  assert.deepEqual(summarizeDashboardCampaigns([{ id: 'solo', status: 'posted' }]), []);
  assert.deepEqual(summarizeDashboardCampaigns(null), []);
});

// ── Provider-aware Command Center ──────────────────────────────────────────

const providerAccounts = [
  ...accounts,
  {
    id: 'UC-chanter',
    accountId: 'UC-chanter',
    provider: 'youtube',
    platform: 'youtube',
    connectedAccountId: 'youtube:UC-chanter',
    providerAccountId: 'UC-chanter',
    username: 'chanterCy',
    displayName: 'chanterCy',
    connected: true
  }
];

test('normalizes provider identity and keeps legacy accounts TikTok', async () => {
  const { normalizeDashboardAccounts } = await accountingPromise;
  const normalized = normalizeDashboardAccounts(providerAccounts);

  assert.deepEqual(normalized.map((account) => account.provider), ['tiktok', 'tiktok', 'youtube']);
  assert.deepEqual(
    normalized.map((account) => account.connectedAccountId),
    ['tiktok:account-a', 'tiktok:account-b', 'youtube:UC-chanter']
  );
  assert.equal(normalized[0].providerAccountId, 'open-a');
  assert.equal(normalized[2].providerAccountId, 'UC-chanter');
});

test('assigns YouTube jobs to the YouTube channel and TikTok jobs to TikTok accounts', async () => {
  const { assignDashboardJobs, groupDashboardJobs, UNASSIGNED_ACCOUNT_ID } = await accountingPromise;
  const jobs = assignDashboardJobs([
    { id: 'tiktok-job', accountId: 'account-a', provider: 'tiktok' },
    { id: 'legacy-tiktok-job', tiktokOpenId: 'open-b' },
    {
      id: 'youtube-job',
      provider: 'youtube',
      accountId: 'UC-chanter',
      connectedAccountId: 'youtube:UC-chanter',
      username: 'chanterCy',
      status: 'posted',
      providerStatus: 'uploaded_private'
    }
  ], providerAccounts);

  assert.deepEqual(jobs.map((job) => job.accountId), ['account-a', 'account-b', 'UC-chanter']);

  // Global counts stay accurate: every job lands in exactly one group.
  const groups = groupDashboardJobs(jobs, providerAccounts);
  assert.equal(groups.reduce((total, group) => total + group.jobs.length, 0), jobs.length);
  const youtubeGroup = groups.find((group) => group.account?.provider === 'youtube');
  assert.equal(youtubeGroup.account.username, 'chanterCy');
  assert.deepEqual(youtubeGroup.jobs.map((job) => job.id), ['youtube-job']);
  assert.equal(groups.some((group) => (group.account?.id || UNASSIGNED_ACCOUNT_ID) === UNASSIGNED_ACCOUNT_ID), false);
});

test('never assigns a job across providers even when ids or usernames collide', async () => {
  const { assignDashboardJobs, UNASSIGNED_ACCOUNT_ID } = await accountingPromise;
  const collidingAccounts = [
    { id: 'shared-id', accountId: 'shared-id', username: 'shared_name', connected: true },
    {
      id: 'shared-id',
      accountId: 'shared-id',
      provider: 'youtube',
      connectedAccountId: 'youtube:shared-id',
      username: 'shared_name',
      connected: true
    }
  ];

  const [youtubeJob, tiktokJob, youtubeByName] = assignDashboardJobs([
    { id: 'yt', provider: 'youtube', accountId: 'shared-id' },
    { id: 'tt', accountId: 'shared-id' },
    { id: 'yt-name', provider: 'youtube', username: 'shared_name' }
  ], collidingAccounts);

  assert.equal(youtubeJob.accountId, 'shared-id');
  assert.equal(tiktokJob.accountId, 'shared-id');
  assert.equal(youtubeByName.accountId, 'shared-id');
  // Each resolved deterministically within its own provider — none fell to
  // the unassigned bucket despite identical ids and usernames.
  assert.equal([youtubeJob, tiktokJob, youtubeByName].some((job) => job.accountId === UNASSIGNED_ACCOUNT_ID), false);
});

test('filters jobs by provider and derives options only from real providers', async () => {
  const { filterJobsByProvider, dashboardProviderOptions } = await accountingPromise;
  const jobs = [
    { id: 'a', provider: 'tiktok' },
    { id: 'b' },
    { id: 'c', provider: 'youtube' },
    { id: 'd', provider: 'linkedin' }
  ];

  assert.deepEqual(filterJobsByProvider(jobs, 'all').map((job) => job.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(filterJobsByProvider(jobs, 'tiktok').map((job) => job.id), ['a', 'b']);
  assert.deepEqual(filterJobsByProvider(jobs, 'youtube').map((job) => job.id), ['c']);

  // Options never include unsupported/reserved providers, even if stored data does.
  assert.deepEqual(dashboardProviderOptions(providerAccounts, jobs), ['tiktok', 'youtube']);
  assert.deepEqual(dashboardProviderOptions(accounts, [{ id: 'a' }]), ['tiktok']);
});

test('uploaded_private YouTube success is never presented as public published', async () => {
  const { isUploadedPrivate } = await accountingPromise;

  assert.equal(isUploadedPrivate({ provider: 'youtube', status: 'posted', providerStatus: 'uploaded_private' }), true);
  assert.equal(isUploadedPrivate({ provider: 'youtube', status: 'published' }), true);
  // A TikTok publish keeps the existing Published vocabulary.
  assert.equal(isUploadedPrivate({ provider: 'tiktok', status: 'posted' }), false);
  assert.equal(isUploadedPrivate({ status: 'posted' }), false);
  // A YouTube job that has not succeeded is not labeled Uploaded Private.
  assert.equal(isUploadedPrivate({ provider: 'youtube', status: 'scheduled' }), false);
  assert.equal(isUploadedPrivate({ provider: 'youtube', status: 'outcome_unknown', providerStatus: 'provider_reconciliation_required' }), false);
});
