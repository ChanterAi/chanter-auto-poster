export const UNASSIGNED_ACCOUNT_ID = 'legacy-unassigned';

// Providers the Command Center may surface. Anything else in stored data is
// never offered as a channel group or filter option.
export const DASHBOARD_PROVIDERS = ['tiktok', 'youtube'];

function text(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

// Canonical provider id for an account or job. A missing value is a legacy
// TikTok record (the documented compatibility rule); explicit values are
// preserved as-is so unknown providers stay visible instead of becoming
// TikTok.
export function providerOf(record) {
  return text(record?.provider || record?.platform).toLowerCase() || 'tiktok';
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
  const provider = providerOf(account);
  return {
    ...account,
    id,
    accountId: id,
    username: text(account?.username),
    displayName: text(account?.displayName),
    avatarUrl: text(account?.avatarUrl),
    platform: provider,
    provider,
    connectedAccountId: text(account?.connectedAccountId) || (id ? `${provider}:${id}` : ''),
    providerAccountId: text(account?.providerAccountId || account?.open_id) || id,
    connected: Boolean(account?.connected),
    connectionStatus: text(account?.connectionStatus) || (account?.connected ? 'connected' : 'disconnected')
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
      account.connectedAccountId,
      account.providerAccountId,
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
  // Identity resolution is provider-scoped: a YouTube job may only resolve
  // to a YouTube channel and a TikTok job to a TikTok account, even when
  // two providers reuse the same raw account id or username.
  const jobProvider = providerOf(job);
  const accounts = normalizeDashboardAccounts(rawAccounts)
    .filter((account) => account.provider === jobProvider);
  const { identity, usernames } = buildAccountIndexes(accounts);
  const nestedAccount = job?.account && typeof job.account === 'object' ? job.account : {};

  const identityReferences = uniqueValues([
    job?.connectedAccountId,
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
    // A private YouTube upload must never roll up into the campaign's
    // public 'Published' bucket — check that truth before the usual
    // campaignJobStatus/status fallback.
    const status = isUploadedPrivate(job)
      ? 'uploaded_private'
      : (text(job?.campaignJobStatus || job?.status).toLowerCase() || 'unknown');
    campaign.jobCount += 1;
    campaign.statusCounts[status] = (campaign.statusCounts[status] || 0) + 1;
    if (status === 'failed') campaign.hasFailures = true;
    if (status === 'retry_required') campaign.hasRetryRequired = true;
    campaigns.set(campaignId, campaign);
  });

  return [...campaigns.values()];
}

export function filterJobsByProvider(jobs, providerId) {
  const wanted = text(providerId).toLowerCase();
  const list = Array.isArray(jobs) ? jobs : [];
  if (!wanted || wanted === 'all') return list;
  return list.filter((job) => providerOf(job) === wanted);
}

// Provider filter options: only supported providers that actually appear in
// the connected accounts or the queue — never a fake or reserved provider.
export function dashboardProviderOptions(accounts, jobs) {
  const present = new Set([
    ...(Array.isArray(accounts) ? accounts : []).map(providerOf),
    ...(Array.isArray(jobs) ? jobs : []).map(providerOf)
  ]);
  return DASHBOARD_PROVIDERS.filter((id) => present.has(id));
}

const SUCCESS_STATUSES = new Set(['posted', 'published', 'completed', 'success']);

/**
 * True when a job's success state is a PRIVATE YouTube upload
 * (providerStatus 'uploaded_private'). The job keeps the internal 'posted'
 * status (API contract untouched), but every aggregate/display surface
 * (status chips, top-level counts, Campaign Overview) must treat this
 * distinctly from the public-sounding 'Published' bucket.
 */
export function isUploadedPrivate(job) {
  return providerOf(job) === 'youtube' && SUCCESS_STATUSES.has(text(job?.status).toLowerCase());
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
