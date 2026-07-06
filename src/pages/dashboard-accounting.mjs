export const UNASSIGNED_ACCOUNT_ID = 'legacy-unassigned';

function text(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function usernameKey(value) {
  return text(value).replace(/^@+/, '').toLowerCase();
}

function addToIndex(index, value, account) {
  const key = text(value);
  if (!key) return;
  const matches = index.get(key) || new Set();
  matches.add(account);
  index.set(key, matches);
}

function addUsernameToIndex(index, value, account) {
  const key = usernameKey(value);
  if (!key) return;
  const matches = index.get(key) || new Set();
  matches.add(account);
  index.set(key, matches);
}

function uniqueValues(values) {
  return [...new Set(values.map(text).filter(Boolean))];
}

export function normalizeDashboardAccount(account) {
  const id = text(account?.id || account?.accountId || account?.open_id || account?.tiktokOpenId);
  return {
    ...account,
    id,
    accountId: id,
    username: text(account?.username),
    displayName: text(account?.displayName),
    avatarUrl: text(account?.avatarUrl),
    platform: 'tiktok',
    connected: Boolean(account?.connected)
  };
}

export function normalizeDashboardAccounts(accounts) {
  return (Array.isArray(accounts) ? accounts : [])
    .map(normalizeDashboardAccount)
    .filter((account) => account.id);
}

function buildAccountIndexes(accounts) {
  const identity = new Map();
  const usernames = new Map();

  accounts.forEach((account) => {
    uniqueValues([
      account.id,
      account.accountId,
      account.open_id,
      account.openId,
      account.tiktokOpenId
    ]).forEach((value) => addToIndex(identity, value, account));
    addUsernameToIndex(usernames, account.username, account);
  });

  return { identity, usernames };
}

function collectMatches(values, index, normalizer = text) {
  const matches = new Set();
  values.forEach((value) => {
    const key = normalizer(value);
    if (!key) return;
    (index.get(key) || []).forEach((account) => matches.add(account));
  });
  return matches;
}

function oneMatchOrNull(matches) {
  return matches.size === 1 ? [...matches][0] : null;
}

export function resolveJobAccount(job, rawAccounts) {
  const accounts = normalizeDashboardAccounts(rawAccounts);
  const { identity, usernames } = buildAccountIndexes(accounts);
  const nestedAccount = job?.account && typeof job.account === 'object' ? job.account : {};

  const identityReferences = uniqueValues([
    job?.accountId,
    job?.tiktokAccountId,
    job?.tiktokOpenId,
    job?.open_id,
    job?.openId,
    nestedAccount.id,
    nestedAccount.accountId,
    nestedAccount.tiktokOpenId,
    nestedAccount.open_id,
    nestedAccount.openId
  ]);
  const identityMatches = collectMatches(identityReferences, identity);
  if (identityMatches.size > 0) return oneMatchOrNull(identityMatches);

  const genericAccountReference = typeof job?.account === 'string' ? text(job.account) : '';
  if (genericAccountReference) {
    const genericMatches = collectMatches([genericAccountReference], identity);
    collectMatches([genericAccountReference], usernames, usernameKey)
      .forEach((account) => genericMatches.add(account));
    if (genericMatches.size > 0) return oneMatchOrNull(genericMatches);
  }

  const usernameMatches = collectMatches([
    job?.username,
    job?.tiktokUsername,
    job?.creatorUsername,
    job?.creator_username,
    nestedAccount.username
  ], usernames, usernameKey);
  return oneMatchOrNull(usernameMatches);
}

export function assignDashboardJobs(jobs, accounts) {
  const normalizedAccounts = normalizeDashboardAccounts(accounts);
  return (Array.isArray(jobs) ? jobs : []).map((job) => {
    const account = resolveJobAccount(job, normalizedAccounts);
    return {
      ...job,
      accountId: account ? account.id : UNASSIGNED_ACCOUNT_ID,
      accountAssignment: account ? 'deterministic' : 'unassigned'
    };
  });
}

export function summarizeDashboardCampaigns(jobs) {
  const campaigns = new Map();

  (Array.isArray(jobs) ? jobs : []).forEach((job) => {
    const campaignId = text(job?.campaignId);
    if (!campaignId) return;

    const campaign = campaigns.get(campaignId) || {
      campaignId,
      jobCount: 0,
      statusCounts: {},
      hasFailures: false,
      hasRetryRequired: false
    };
    const status = text(job?.campaignJobStatus || job?.status).toLowerCase() || 'unknown';
    campaign.jobCount += 1;
    campaign.statusCounts[status] = (campaign.statusCounts[status] || 0) + 1;
    if (status === 'failed') campaign.hasFailures = true;
    if (status === 'retry_required') campaign.hasRetryRequired = true;
    campaigns.set(campaignId, campaign);
  });

  return [...campaigns.values()];
}

export function groupDashboardJobs(jobs, accounts) {
  const normalizedAccounts = normalizeDashboardAccounts(accounts);
  const accountMap = new Map(normalizedAccounts.map((account) => [account.id, account]));
  const groupedJobs = new Map();

  jobs.forEach((job) => {
    const accountId = accountMap.has(job.accountId) ? job.accountId : UNASSIGNED_ACCOUNT_ID;
    const group = groupedJobs.get(accountId) || [];
    group.push(job);
    groupedJobs.set(accountId, group);
  });

  const groups = normalizedAccounts
    .filter((account) => groupedJobs.has(account.id))
    .map((account) => ({ account, jobs: groupedJobs.get(account.id) }));

  if (groupedJobs.has(UNASSIGNED_ACCOUNT_ID)) {
    groups.push({ account: null, jobs: groupedJobs.get(UNASSIGNED_ACCOUNT_ID) });
  }

  return groups;
}
