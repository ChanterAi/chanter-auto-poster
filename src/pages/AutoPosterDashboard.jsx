import { useEffect, useMemo, useState } from 'react';
import './AutoPosterDashboard.css';
import {
  assignDashboardJobs,
  dashboardProviderOptions,
  filterJobsByProvider,
  groupDashboardJobs,
  isUploadedPrivate,
  normalizeDashboardAccounts,
  summarizeDashboardCampaigns,
  UNASSIGNED_ACCOUNT_ID
} from './dashboard-accounting.mjs';

const PROVIDER_LABELS = { tiktok: 'TikTok', youtube: 'YouTube' };
const PROVIDER_MARKS = { tiktok: 'TT', youtube: 'YT' };

function providerDisplayName(provider) {
  return PROVIDER_LABELS[provider] || 'Channel';
}

const STATUS_FILTERS = ['all', 'scheduled', 'processing', 'posted', 'uploaded_private', 'failed'];
const STATUS_ALIASES = {
  queued: 'scheduled',
  publishing: 'processing',
  in_progress: 'processing',
  published: 'posted',
  completed: 'posted',
  success: 'posted',
  error: 'failed',
  canceled: 'cancelled'
};

// Premium display names for internal status values. Internal values stay
// unchanged so filters, CSS classes, and the API contract are untouched.
const STATUS_LABELS = {
  all: 'All',
  pending: 'Prepared',
  scheduled: 'Queued',
  queued: 'Queued',
  processing: 'Publishing',
  posting: 'Publishing',
  ready: 'Needs Review',
  posted: 'Published',
  uploaded_private: 'Uploaded Private',
  failed: 'Needs Review',
  cancelled: 'Cancelled',
  retry_required: 'Retry Required'
};

function statusDisplay(status) {
  const key = asText(status).toLowerCase();
  return STATUS_LABELS[key] || key.replaceAll('_', ' ');
}

function firstValue(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function asText(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return firstValue(value.message, value.reason, value.code, JSON.stringify(value)) || '';
}

function parseDate(value) {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate();
  if (typeof value.seconds === 'number') return new Date(value.seconds * 1000);
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(value) {
  const date = parseDate(value);
  if (!date) return 'Not available';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(date);
}

function normalizeHashtags(value) {
  if (Array.isArray(value)) return value.map(asText).filter(Boolean).join(' ');
  return asText(value);
}

function normalizeStatus(value, scheduledAt) {
  const raw = asText(value || 'pending').toLowerCase().replace(/[\s-]+/g, '_');
  if (raw === 'pending' && scheduledAt) return 'scheduled';
  return STATUS_ALIASES[raw] || raw;
}

function normalizeJob(job) {
  const scheduledAt = firstValue(
    job.scheduledAt,
    job.scheduledTimeUTC,
    job.scheduled_time,
    job.scheduleAt
  );
  const caption = asText(firstValue(job.caption, job.content?.caption, job.description));
  const mediaUrl = asText(firstValue(
    job.mediaUrl,
    job.mediaPath,
    job.videoPath,
    job.imagePath,
    job.publicMediaUrl,
    job.publicImageUrl,
    job.media?.url
  ));
  const mediaType = asText(firstValue(job.mediaType, job.media?.type, job.mimeType)).toLowerCase();
  const lastResult = firstValue(job.lastResult, job.result, job.publishResult);
  const errorEvidence = job.errorEvidence && typeof job.errorEvidence === 'object' ? job.errorEvidence : null;
  const lastError = asText(firstValue(
    job.lastError,
    job.error,
    errorEvidence?.reason,
    lastResult?.reason,
    lastResult?.error,
    lastResult?.message
  ));
  const status = normalizeStatus(job.status, scheduledAt);
  // A private YouTube upload keeps the internal 'posted' status (filters,
  // API contract, and TikTok's own "Published" vocabulary are untouched),
  // but every aggregate surface (status chips, top-level counts, Campaign
  // Overview) must count and label it as a private upload, never as
  // public "Published".
  const displayStatus = isUploadedPrivate(job) ? 'uploaded_private' : status;

  return {
    ...job,
    id: asText(firstValue(job.id, job.jobId, job.postId)),
    provider: asText(firstValue(job.provider, job.platform)).toLowerCase() || 'tiktok',
    connectedAccountId: asText(job.connectedAccountId),
    providerStatus: asText(job.providerStatus).toLowerCase(),
    displayStatus,
    title: asText(firstValue(
      job.title,
      job.postTitle,
      job.originalName,
      job.fileName,
      caption.split(/\r?\n/).find(Boolean),
      'Untitled post'
    )),
    caption,
    hashtags: normalizeHashtags(firstValue(job.hashtags, job.content?.hashtags, job.tags)),
    scheduledAt,
    createdAt: firstValue(job.createdAt, job.created_time),
    postedAt: firstValue(job.postedAt, job.publishedAt, job.completedAt),
    acceptedAt: firstValue(job.acceptedAt),
    lastAttemptAt: firstValue(lastResult?.completedAt),
    status,
    campaignId: asText(firstValue(job.campaignId, job.campaign_id)),
    campaignJobStatus: asText(firstValue(job.campaignJobStatus, job.campaign_job_status)).toLowerCase(),
    errorEvidence,
    // YouTube privacy truth comes from the provider metadata (the adapter
    // forces 'private'); TikTok keeps its own privacy vocabulary.
    privacy: asText(firstValue(
      job.providerMetadata?.youtube?.privacyStatus,
      job.privacyLevel,
      job.privacy,
      job.privacy_level,
      'Not set'
    )),
    attempts: Number(firstValue(job.claimAttempts, job.attempts, job.retryCount, 0)) || 0,
    lastError,
    mediaUrl,
    thumbnailUrl: asText(firstValue(
      job.thumbnailUrl,
      job.thumbnail,
      job.coverUrl,
      job.media?.thumbnail,
      mediaType.includes('image') || mediaType === 'photo' ? mediaUrl : ''
    )),
    isVideo: mediaType.includes('video') || /\.(mp4|mov|webm)(?:\?|$)/i.test(mediaUrl),
    logs: firstValue(job.logs, job.events, job.history, []),
    lastResult
  };
}

function accountLabel(account) {
  if (!account) return 'Legacy / Unassigned';
  if (account.username) return `@${account.username}`;
  return account.displayName || account.id || `${providerDisplayName(account.provider)} account`;
}

function connectionStateLabel(account) {
  if (account.connected) return 'Connected';
  if (account.connectionStatus === 'reauthorization_required') return 'Reauthorization required';
  return 'Unavailable';
}

function AccountAvatar({ account, className = 'account-avatar' }) {
  return (
    <div className={className} aria-hidden="true">
      {account?.avatarUrl ? <img src={account.avatarUrl} alt="" /> : account ? PROVIDER_MARKS[account.provider] || 'TT' : '?'}
    </div>
  );
}

function AccountCard({ account, jobCount, active }) {
  return (
    <article className="account-card">
      <AccountAvatar account={account} />
      <div className="account-copy">
        <div className="account-title-row">
          <strong>{accountLabel(account)}</strong>
          <span className="provider-badge">{providerDisplayName(account.provider)}</span>
          {active && <span className="active-account-badge">Active</span>}
          <span className={`connection-badge ${account.connected ? 'connected' : ''}`}>
            {connectionStateLabel(account)}
          </span>
        </div>
        <span>
          {account.displayName || 'Display name unavailable'} / {jobCount} {jobCount === 1 ? 'campaign' : 'campaigns'}
          {account.connected && account.publishingReady === false ? ' / Publishing blocked' : ''}
        </span>
      </div>
    </article>
  );
}

function JobAccountBadge({ account, provider }) {
  return (
    <div className={`job-account-badge${account ? '' : ' unassigned'}`}>
      <AccountAvatar account={account} className="job-account-avatar" />
      <span>
        <small>{providerDisplayName(account ? account.provider : provider)}</small>
        <strong>{account ? accountLabel(account) : 'Legacy / Unassigned'}</strong>
      </span>
    </div>
  );
}

function AccountGroupHeader({ account, jobCount }) {
  if (!account) {
    return (
      <header className="account-group-header legacy-group-header">
        <AccountAvatar account={null} />
        <div className="account-group-copy">
          <h3>Legacy / Unassigned campaigns</h3>
          <p>These older campaigns were created before channel isolation and cannot be safely assigned.</p>
        </div>
        <span className="group-job-count">{jobCount} {jobCount === 1 ? 'campaign' : 'campaigns'}</span>
      </header>
    );
  }

  return (
    <header className="account-group-header">
      <AccountAvatar account={account} />
      <div className="account-group-copy">
        <div className="account-group-title">
          <h3>{account.username ? `@${account.username}` : 'Username unavailable'}</h3>
          <span className="provider-badge">{providerDisplayName(account.provider)}</span>
          <span className={`connection-badge ${account.connected ? 'connected' : ''}`}>
            {connectionStateLabel(account)}
          </span>
        </div>
        <p>{account.displayName || 'Display name unavailable'}</p>
      </div>
      <span className="group-job-count">{jobCount} {jobCount === 1 ? 'campaign' : 'campaigns'}</span>
    </header>
  );
}

function MediaPreview({ job }) {
  if (!job.mediaUrl && !job.thumbnailUrl) {
    return <div className="media-placeholder">No preview</div>;
  }

  if (job.isVideo && job.mediaUrl) {
    return (
      <div className="media-frame">
        <video
          className="job-media"
          src={job.mediaUrl}
          poster={job.thumbnailUrl || undefined}
          controls
          muted
          preload="metadata"
        />
        <span className="media-type-label">Video</span>
      </div>
    );
  }

  return (
    <div className="media-frame">
      <img className="job-media" src={job.thumbnailUrl || job.mediaUrl} alt="" loading="lazy" />
      <span className="media-type-label">Photo</span>
    </div>
  );
}

function DetailItem({ label, value }) {
  return (
    <div className="detail-item">
      <span>{label}</span>
      <strong>{value || 'Not available'}</strong>
    </div>
  );
}

function CopyEvidenceButton({ payload }) {
  const [copied, setCopied] = useState(false);

  const copyEvidence = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard unavailable (permissions/insecure context); leave label unchanged.
    }
  };

  return (
    <button type="button" className="copy-evidence" onClick={copyEvidence}>
      {copied ? 'Copied' : 'Copy Evidence'}
    </button>
  );
}

function JobCard({ job, account }) {
  // Campaign evidence payload — operational fields only, never tokens or auth data.
  const evidencePayload = {
    jobId: job.id,
    campaignId: job.campaignId || null,
    provider: job.provider,
    connectedAccountId: job.connectedAccountId || null,
    accountId: job.accountId,
    channelHandle: job.username ? `@${job.username}` : null,
    status: job.status,
    providerStatus: job.providerStatus || null,
    scheduledAt: job.scheduledAt || null,
    publishedAt: job.postedAt || null,
    errorReason: job.lastError || null,
    lockedAt: job.lockedAt || null,
    lockedBy: job.lockedBy || null,
    updatedAt: job.updatedAt || null,
    logs: job.logs,
    lastResult: job.lastResult
  };
  const assetState = job.mediaUrl || job.thumbnailUrl
    ? (job.isVideo ? 'Video attached' : 'Image attached')
    : 'Asset required';

  return (
    <article className="job-card">
      <div className="media-cell"><MediaPreview job={job} /></div>

      <div className="job-content">
        <JobAccountBadge account={account} provider={job.provider} />
        <div className="job-heading">
          <div>
            <span className="account-kicker">
              Campaign {job.id.slice(0, 8)}
              {job.campaignId && <span className="campaign-chip">Batch {job.campaignId.slice(0, 8)}</span>}
            </span>
            <h2>{job.title}</h2>
          </div>
          <div className="status-badges">
            <span className={`status-badge status-${job.displayStatus}`}>
              {statusDisplay(job.displayStatus)}
            </span>
            {job.campaignJobStatus === 'retry_required' && (
              <span className="status-badge status-retry_required">Retry Required</span>
            )}
          </div>
        </div>

        {job.caption && <p className="caption">{job.caption}</p>}
        {job.hashtags && <p className="hashtags">{job.hashtags}</p>}

        <div className="job-metadata">
          <DetailItem label="Asset" value={assetState} />
          <DetailItem label="Release window" value={formatDate(job.scheduledAt)} />
          <DetailItem label="Privacy" value={job.privacy.replaceAll('_', ' ')} />
          <DetailItem label="Attempts" value={String(job.attempts)} />
          <DetailItem label="Created" value={formatDate(job.createdAt)} />
          {job.acceptedAt && <DetailItem label="Accepted" value={formatDate(job.acceptedAt)} />}
          <DetailItem label={job.provider === 'youtube' ? 'Uploaded' : 'Published'} value={formatDate(job.postedAt)} />
          {job.lastAttemptAt && <DetailItem label="Last attempt" value={formatDate(job.lastAttemptAt)} />}
        </div>

        {job.lastError && (
          <div className="error-box">
            <strong>Error reason</strong>
            <span>{job.lastError}</span>
            {job.errorEvidence && (
              <span className="evidence-note">
                {job.errorEvidence.retryable
                  ? 'Retry-safe — the publishing engine can retry this campaign.'
                  : 'Terminal — needs manual attention.'}
              </span>
            )}
          </div>
        )}

        <div className="job-footer">
          <details className="job-details">
            <summary>Publishing evidence</summary>
            <CopyEvidenceButton payload={evidencePayload} />
            <pre>{JSON.stringify(evidencePayload, null, 2)}</pre>
          </details>
          <div className="job-actions" aria-label={`Actions for ${job.title}`}>
            {['Retry', 'Cancel', 'Delete', 'Publish Now'].map((label) => (
              <button
                className={label === 'Delete' ? 'danger-action' : ''}
                type="button"
                disabled
                title="Monitoring mode: this action is not wired to a dashboard endpoint"
                key={label}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </article>
  );
}

export default function AutoPosterDashboard() {
  const [data, setData] = useState({ accounts: [], jobs: [], appTimeZone: '', selectedAccountId: '' });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [accountFilter, setAccountFilter] = useState('all');
  const [providerFilter, setProviderFilter] = useState('all');
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');

    fetch('/api/private/autoposter/dashboard', {
      headers: { Accept: 'application/json' },
      signal: controller.signal
    })
      .then(async (response) => {
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.ok) throw new Error(payload.reason || 'Unable to load dashboard');
        return payload;
      })
      .then((payload) => setData({
        accounts: Array.isArray(payload.accounts) ? payload.accounts : [],
        jobs: Array.isArray(payload.jobs) ? payload.jobs : [],
        appTimeZone: payload.appTimeZone || '',
        selectedAccountId: payload.selectedAccountId || ''
      }))
      .catch((requestError) => {
        if (requestError.name !== 'AbortError') setError(requestError.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [reloadKey]);

  const accounts = useMemo(() => normalizeDashboardAccounts(data.accounts), [data.accounts]);

  const jobs = useMemo(() => {
    return assignDashboardJobs(data.jobs, accounts)
      .map((job) => normalizeJob(job))
      .sort((a, b) => {
        const aTime = parseDate(a.scheduledAt)?.getTime() || Number.MAX_SAFE_INTEGER;
        const bTime = parseDate(b.scheduledAt)?.getTime() || Number.MAX_SAFE_INTEGER;
        return aTime - bTime;
      });
  }, [accounts, data.jobs]);

  const accountMap = useMemo(() => {
    return new Map(accounts.map((account) => [account.id, account]));
  }, [accounts]);

  // Provider filter: 'all' preserves today's behavior exactly; a specific
  // provider scopes channels, queue, counts, and campaigns to it.
  const providerOptions = useMemo(() => dashboardProviderOptions(accounts, jobs), [accounts, jobs]);
  const visibleAccounts = providerFilter === 'all'
    ? accounts
    : accounts.filter((account) => account.provider === providerFilter);
  const providerScopedJobs = filterJobsByProvider(jobs, providerFilter);

  const changeProviderFilter = (provider) => {
    setProviderFilter(provider);
    if (accountFilter === 'all' || provider === 'all') return;
    // Legacy/unassigned jobs are TikTok by the documented compatibility rule.
    if (accountFilter === UNASSIGNED_ACCOUNT_ID) {
      if (provider !== 'tiktok') setAccountFilter('all');
      return;
    }
    const selected = accountMap.get(accountFilter);
    if (!selected || selected.provider !== provider) setAccountFilter('all');
  };

  const accountScopedJobs = providerScopedJobs.filter((job) => (
    accountFilter === 'all' || job.accountId === accountFilter
  ));

  const visibleJobs = accountScopedJobs.filter((job) => (
    statusFilter === 'all' || job.displayStatus === statusFilter
  ));

  const counts = accountScopedJobs.reduce((result, job) => {
    result[job.displayStatus] = (result[job.displayStatus] || 0) + 1;
    return result;
  }, { all: accountScopedJobs.length });

  const jobGroups = accountFilter === 'all'
    ? groupDashboardJobs(visibleJobs, accounts)
    : [];
  const hasUnassignedJobs = providerScopedJobs.some((job) => job.accountId === UNASSIGNED_ACCOUNT_ID);
  const campaigns = summarizeDashboardCampaigns(accountScopedJobs);

  return (
    <main className="control-room">
      <nav className="dashboard-nav" aria-label="AutoPoster navigation">
        <a className="product-link" href="/private/autoposter">
          <span className="product-mark">C</span>
          <span><strong>CHANTER</strong><small>AutoPoster</small></span>
        </a>
        <div className="dashboard-nav-actions">
          <span className="internal-label"><span></span>Command Center</span>
          <form action="/logout" method="post"><button type="submit">End Session</button></form>
        </div>
      </nav>

      <header className="page-header">
        <div>
          <a className="back-link" href="/private/autoposter">&larr; Back to CHANTER AutoPoster</a>
          <p className="eyebrow">CHANTER AutoPoster</p>
          <h1>Command Center</h1>
          <p>Monitor campaigns, release windows, publishing progress, and evidence from one read-only view.</p>
        </div>
        <div className="header-actions">
          <span className="timezone-label">Times shown in {Intl.DateTimeFormat().resolvedOptions().timeZone}</span>
          <button type="button" onClick={() => setReloadKey((key) => key + 1)} disabled={loading}>
            {loading ? 'Refreshing...' : 'Refresh data'}
          </button>
        </div>
      </header>

      {accounts.length > 0 && (
        <section className="accounts-section" aria-labelledby="accounts-heading">
          <div className="section-heading">
            <div><p className="eyebrow">Channels</p><h2 id="accounts-heading">Publishing Channels</h2></div>
          </div>
          <div className="account-grid">
            {visibleAccounts.map((account) => (
              <AccountCard
                account={account}
                jobCount={jobs.filter((job) => job.accountId === account.id).length}
                active={account.provider === 'tiktok' && account.id === data.selectedAccountId}
                key={account.connectedAccountId || account.id}
              />
            ))}
          </div>
        </section>
      )}

      {!loading && !error && (
        <section className="metric-grid" aria-label="Campaign state overview">
          {STATUS_FILTERS.map((status) => (
            <button
              type="button"
              className={statusFilter === status ? 'metric-card active' : 'metric-card'}
              onClick={() => setStatusFilter(status)}
              key={status}
            >
              <span>{status === 'all' ? 'Total campaigns' : statusDisplay(status)}</span>
              <strong>{counts[status] || 0}</strong>
            </button>
          ))}
        </section>
      )}

      {!loading && !error && campaigns.length > 0 && (
        <section className="campaign-strip" aria-labelledby="campaigns-heading">
          <div className="section-heading">
            <div><p className="eyebrow">Publishing evidence</p><h2 id="campaigns-heading">Campaign overview</h2></div>
            <span className="result-count">{campaigns.length} {campaigns.length === 1 ? 'campaign' : 'campaigns'}</span>
          </div>
          <div className="campaign-grid">
            {campaigns.map((campaign) => (
              <article
                className={`campaign-card${campaign.hasFailures ? ' has-failures' : campaign.hasRetryRequired ? ' has-retries' : ''}`}
                key={campaign.campaignId}
              >
                <header>
                  <strong>Campaign {campaign.campaignId.slice(0, 8)}</strong>
                  <span>{campaign.jobCount} {campaign.jobCount === 1 ? 'release' : 'releases'}</span>
                </header>
                <div className="campaign-status-counts">
                  {Object.entries(campaign.statusCounts).map(([status, count]) => (
                    <span className={`status-badge status-${status}`} key={status}>
                      {statusDisplay(status)} {count}
                    </span>
                  ))}
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      <section className="jobs-section" aria-labelledby="jobs-heading">
        <div className="section-heading jobs-heading-row">
          <div>
            <p className="eyebrow">Release pipeline</p>
            <h2 id="jobs-heading">Release Queue</h2>
          </div>
          <span className="result-count">{visibleJobs.length} of {accountScopedJobs.length}</span>
        </div>

        <div className="toolbar">
          <div className="status-filters" aria-label="Filter by campaign state">
            {STATUS_FILTERS.map((status) => (
              <button
                type="button"
                className={statusFilter === status ? 'active' : ''}
                onClick={() => setStatusFilter(status)}
                key={status}
              >
                {statusDisplay(status)}<span>{counts[status] || 0}</span>
              </button>
            ))}
          </div>

          <div className="toolbar-filters">
            {providerOptions.length > 1 && (
              <label className="account-filter">
                <span>Provider</span>
                <select value={providerFilter} onChange={(event) => changeProviderFilter(event.target.value)}>
                  <option value="all">All providers</option>
                  {providerOptions.map((provider) => (
                    <option value={provider} key={provider}>{providerDisplayName(provider)}</option>
                  ))}
                </select>
              </label>
            )}
            <label className="account-filter">
              <span>Channel</span>
              <select value={accountFilter} onChange={(event) => setAccountFilter(event.target.value)}>
                <option value="all">All channels</option>
                {visibleAccounts.map((account) => (
                  <option value={account.id} key={account.connectedAccountId || account.id}>{accountLabel(account)}</option>
                ))}
                {hasUnassignedJobs && <option value={UNASSIGNED_ACCOUNT_ID}>Legacy / Unassigned campaigns</option>}
              </select>
            </label>
          </div>
        </div>

        {error && (
          <div className="state-card error-state">
            <strong>Dashboard data could not be loaded.</strong>
            <span>{error}</span>
            <button type="button" onClick={() => setReloadKey((key) => key + 1)}>Try again</button>
          </div>
        )}

        {loading && !error && <div className="state-card">Loading the release queue...</div>}

        {!loading && !error && visibleJobs.length === 0 && (
          jobs.length === 0 ? (
            <div className="state-card">
              <strong>No campaigns queued yet.</strong>
              <span>Prepare campaigns from CHANTER AutoPoster — they appear here with live campaign state.</span>
              <a className="empty-action" href="/private/autoposter">Open CHANTER AutoPoster</a>
            </div>
          ) : (
            <div className="state-card">
              <strong>No campaigns match these filters.</strong>
              <span>Change the campaign state or channel filter to review other releases.</span>
            </div>
          )
        )}

        {!loading && !error && visibleJobs.length > 0 && (
          accountFilter === 'all' ? (
            <div className="job-groups">
              {jobGroups.map((group) => {
                const groupId = group.account?.id || UNASSIGNED_ACCOUNT_ID;
                return (
                  <section className="account-job-group" aria-labelledby={`account-group-${groupId}`} key={groupId}>
                    <div id={`account-group-${groupId}`}>
                      <AccountGroupHeader account={group.account} jobCount={group.jobs.length} />
                    </div>
                    <div className="job-list">
                      {group.jobs.map((job, index) => (
                        <JobCard
                          job={job}
                          account={group.account}
                          key={job.id || `${groupId}-${index}`}
                        />
                      ))}
                    </div>
                  </section>
                );
              })}
            </div>
          ) : (
            <div className="job-list">
              {visibleJobs.map((job, index) => (
                <JobCard
                  job={job}
                  account={accountMap.get(job.accountId) || null}
                  key={job.id || `${job.accountId}-${index}`}
                />
              ))}
            </div>
          )
        )}
      </section>
    </main>
  );
}
