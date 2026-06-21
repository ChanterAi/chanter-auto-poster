import { useEffect, useMemo, useState } from 'react';
import './AutoPosterDashboard.css';

const STATUS_FILTERS = ['all', 'scheduled', 'processing', 'posted', 'failed'];
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
  const accountId = asText(firstValue(
    job.accountId,
    job.tiktokAccountId,
    job.tiktokOpenId,
    job.account?.id,
    'legacy'
  ));
  const lastResult = firstValue(job.lastResult, job.result, job.publishResult);
  const lastError = asText(firstValue(
    job.lastError,
    job.error,
    lastResult?.reason,
    lastResult?.error,
    lastResult?.message
  ));

  return {
    ...job,
    id: asText(firstValue(job.id, job.jobId, job.postId)),
    accountId,
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
    status: normalizeStatus(job.status, scheduledAt),
    privacy: asText(firstValue(job.privacyLevel, job.privacy, job.privacy_level, 'Not set')),
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
  if (!account) return 'Unassigned / legacy';
  if (account.id === 'legacy' || account.accountId === 'legacy') return 'Legacy / unassigned';
  if (account.username) return `@${account.username}`;
  return account.displayName || account.id || 'TikTok account';
}

function AccountCard({ account, jobCount, active }) {
  return (
    <article className="account-card">
      <div className="account-avatar" aria-hidden={!account.avatarUrl}>
        {account.avatarUrl ? <img src={account.avatarUrl} alt="" /> : 'TT'}
      </div>
      <div className="account-copy">
        <div className="account-title-row">
          <strong>{accountLabel(account)}</strong>
          {active && <span className="active-account-badge">Active</span>}
          <span className={`connection-badge ${account.connected ? 'connected' : ''}`}>
            {account.connected ? 'Connected' : 'Unavailable'}
          </span>
        </div>
        <span>{account.displayName || 'TikTok'} · {jobCount} {jobCount === 1 ? 'job' : 'jobs'}</span>
      </div>
    </article>
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

function JobCard({ job, account }) {
  const debugPayload = {
    jobId: job.id,
    accountId: job.accountId,
    status: job.status,
    lockedAt: job.lockedAt || null,
    lockedBy: job.lockedBy || null,
    updatedAt: job.updatedAt || null,
    logs: job.logs,
    lastResult: job.lastResult
  };

  return (
    <article className="job-card">
      <div className="media-cell"><MediaPreview job={job} /></div>

      <div className="job-content">
        <div className="job-heading">
          <div>
            <span className="account-kicker">{accountLabel(account)} · Job {job.id.slice(0, 8)}</span>
            <h2>{job.title}</h2>
          </div>
          <span className={`status-badge status-${job.status}`}>{job.status}</span>
        </div>

        {job.caption && <p className="caption">{job.caption}</p>}
        {job.hashtags && <p className="hashtags">{job.hashtags}</p>}

        <div className="job-metadata">
          <DetailItem label="Scheduled (local)" value={formatDate(job.scheduledAt)} />
          <DetailItem label="Privacy" value={job.privacy.replaceAll('_', ' ')} />
          <DetailItem label="Attempts" value={String(job.attempts)} />
          <DetailItem label="Created" value={formatDate(job.createdAt)} />
          <DetailItem label="Posted" value={formatDate(job.postedAt)} />
        </div>

        {job.lastError && (
          <div className="error-box">
            <strong>Last error</strong>
            <span>{job.lastError}</span>
          </div>
        )}

        <div className="job-footer">
          <details className="job-details">
            <summary>Logs &amp; details</summary>
            <pre>{JSON.stringify(debugPayload, null, 2)}</pre>
          </details>
          <div className="job-actions" aria-label={`Actions for ${job.title}`}>
            {['Retry', 'Cancel', 'Delete', 'Post Now'].map((label) => (
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

  const jobs = useMemo(() => {
    return data.jobs
      .map((job) => normalizeJob(job))
      .sort((a, b) => {
        const aTime = parseDate(a.scheduledAt)?.getTime() || Number.MAX_SAFE_INTEGER;
        const bTime = parseDate(b.scheduledAt)?.getTime() || Number.MAX_SAFE_INTEGER;
        return aTime - bTime;
      });
  }, [data.accounts, data.jobs]);

  const accountMap = useMemo(() => {
    const map = new Map(data.accounts.map((account) => [String(account.id), account]));
    jobs.forEach((job) => {
      if (!map.has(job.accountId)) {
        map.set(job.accountId, { id: job.accountId, platform: 'tiktok', connected: false });
      }
    });
    return map;
  }, [data.accounts, jobs]);

  const visibleJobs = jobs.filter((job) => {
    const matchesStatus = statusFilter === 'all' || job.status === statusFilter;
    const matchesAccount = accountFilter === 'all' || job.accountId === accountFilter;
    return matchesStatus && matchesAccount;
  });

  const counts = jobs.reduce((result, job) => {
    result[job.status] = (result[job.status] || 0) + 1;
    return result;
  }, { all: jobs.length });

  return (
    <main className="control-room">
      <nav className="dashboard-nav" aria-label="AutoPoster navigation">
        <a className="product-link" href="/private/autoposter">
          <span className="product-mark">C</span>
          <span><strong>CHANTER</strong><small>Auto Poster</small></span>
        </a>
        <div className="dashboard-nav-actions">
          <span className="internal-label"><span></span>Internal control room</span>
          <form action="/logout" method="post"><button type="submit">Log out</button></form>
        </div>
      </nav>

      <header className="page-header">
        <div>
          <a className="back-link" href="/private/autoposter">← Back to AutoPoster</a>
          <p className="eyebrow">Internal operations</p>
          <h1>AutoPoster Control Room</h1>
          <p>Monitor TikTok schedules, posting progress, and failures from one read-only view.</p>
        </div>
        <div className="header-actions">
          <span className="timezone-label">Times shown in {Intl.DateTimeFormat().resolvedOptions().timeZone}</span>
          <button type="button" onClick={() => setReloadKey((key) => key + 1)} disabled={loading}>
            {loading ? 'Refreshing…' : 'Refresh data'}
          </button>
        </div>
      </header>

      {data.accounts.length > 0 && (
        <section className="accounts-section" aria-labelledby="accounts-heading">
          <div className="section-heading">
            <div><p className="eyebrow">Connections</p><h2 id="accounts-heading">TikTok accounts</h2></div>
          </div>
          <div className="account-grid">
            {data.accounts.map((account) => (
              <AccountCard
                account={account}
                jobCount={jobs.filter((job) => job.accountId === String(account.id)).length}
                active={String(account.id) === data.selectedAccountId}
                key={account.id}
              />
            ))}
          </div>
        </section>
      )}

      {!loading && !error && (
        <section className="metric-grid" aria-label="Job status overview">
          {['all', 'scheduled', 'processing', 'posted', 'failed'].map((status) => (
            <button
              type="button"
              className={statusFilter === status ? 'metric-card active' : 'metric-card'}
              onClick={() => setStatusFilter(status)}
              key={status}
            >
              <span>{status === 'all' ? 'Total jobs' : status}</span>
              <strong>{counts[status] || 0}</strong>
            </button>
          ))}
        </section>
      )}

      <section className="jobs-section" aria-labelledby="jobs-heading">
        <div className="section-heading jobs-heading-row">
          <div>
            <p className="eyebrow">Firestore jobs</p>
            <h2 id="jobs-heading">Scheduled posts</h2>
          </div>
          <span className="result-count">{visibleJobs.length} of {jobs.length}</span>
        </div>

        <div className="toolbar">
          <div className="status-filters" aria-label="Filter by status">
            {STATUS_FILTERS.map((status) => (
              <button
                type="button"
                className={statusFilter === status ? 'active' : ''}
                onClick={() => setStatusFilter(status)}
                key={status}
              >
                {status}<span>{counts[status] || 0}</span>
              </button>
            ))}
          </div>

          <label className="account-filter">
            <span>Account</span>
            <select value={accountFilter} onChange={(event) => setAccountFilter(event.target.value)}>
              <option value="all">All accounts</option>
              {[...accountMap.values()].map((account) => (
                <option value={String(account.id)} key={account.id}>{accountLabel(account)}</option>
              ))}
            </select>
          </label>
        </div>

        {error && (
          <div className="state-card error-state">
            <strong>Dashboard data could not be loaded.</strong>
            <span>{error}</span>
            <button type="button" onClick={() => setReloadKey((key) => key + 1)}>Try again</button>
          </div>
        )}

        {loading && !error && <div className="state-card">Loading Firestore jobs…</div>}

        {!loading && !error && visibleJobs.length === 0 && (
          <div className="state-card">
            <strong>No jobs match these filters.</strong>
            <span>Change the status or account filter to review other posts.</span>
          </div>
        )}

        {!loading && !error && visibleJobs.length > 0 && (
          <div className="job-list">
            {visibleJobs.map((job) => (
              <JobCard job={job} account={accountMap.get(job.accountId)} key={job.id} />
            ))}
          </div>
        )}
      </section>
    </main>
  );
}
