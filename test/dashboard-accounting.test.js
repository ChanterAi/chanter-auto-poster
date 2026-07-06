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
