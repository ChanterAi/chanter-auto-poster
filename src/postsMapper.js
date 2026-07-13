'use strict';

const config = require('./config');
const { Timestamp } = require('./firestore');

const DEFAULT_USER_ID = config.defaultUserId;

// Evidence log cap. Publish attempts are already bounded by
// SCHEDULER_MAX_CLAIM_ATTEMPTS, so this is a belt-and-braces limit that
// keeps a single document from growing without bound no matter what.
const POST_HISTORY_LIMIT = 50;
const SAFE_RESULT_STRING_FIELDS = Object.freeze([
  'mode',
  'reason',
  'code',
  'completedAt',
  'providerStatus',
  'providerErrorCategory'
]);
const SAFE_RESULT_BOOLEAN_FIELDS = Object.freeze([
  'ok',
  'outcomeUnknown',
  'willRetry',
  'published',
  'sessionCreated',
  'definitiveFailure'
]);
const SAFE_RESULT_NUMBER_FIELDS = Object.freeze(['attempts']);
const SAFE_RESPONSE_FIELDS = new Set([
  'publish_id', 'publishid', 'post_id', 'postid', 'item_id', 'itemid',
  'video_id', 'videoid', 'share_url', 'shareurl', 'post_url', 'posturl',
  'permalink', 'public_url', 'publicurl', 'status', 'publish_status',
  'publishstatus', 'log_id', 'logid', 'privacy_status', 'upload_status',
  'channel_id', 'uploaded', 'size', 'chunks'
]);
const SAFE_RESPONSE_CONTAINERS = new Set(['data', 'result', 'video']);

function scrubEvidenceText(value, maxLength = 500) {
  return String(value || '')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    .replace(/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9_-]{12,}|github_pat_[A-Za-z0-9_-]{12,})\b/g, '[redacted]')
    .replace(
      /\b(access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|authorization|credential|externalCustomerId|externalSubscriptionId|entitlementOverrides)\b\s*[:=]\s*["']?[^\s,"'}]+/gi,
      '$1=[redacted]'
    )
    .replace(/\b(?:ya29\.[A-Za-z0-9._-]+|sk_(?:live|test)_[A-Za-z0-9_-]+|cus_[A-Za-z0-9_-]+|sub_[A-Za-z0-9_-]+)\b/g, '[redacted]')
    .slice(0, maxLength);
}

function safeResponseScalar(key, value) {
  if (!['string', 'number', 'boolean'].includes(typeof value)) return undefined;
  if (/url|permalink/i.test(key)) {
    try {
      const parsed = new URL(String(value));
      if (!['http:', 'https:'].includes(parsed.protocol)) return undefined;
      parsed.username = '';
      parsed.password = '';
      parsed.search = '';
      parsed.hash = '';
      return parsed.toString().slice(0, 500);
    } catch {
      return undefined;
    }
  }
  if (typeof value === 'string') return scrubEvidenceText(value, 500);
  return value;
}

function sanitizeProviderResponse(value, depth = 0) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 3) return null;
  const safe = {};
  for (const [key, raw] of Object.entries(value)) {
    const normalizedKey = String(key).toLowerCase();
    if (SAFE_RESPONSE_FIELDS.has(normalizedKey)) {
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const nested = sanitizeProviderResponse(raw, depth + 1);
        if (nested && Object.keys(nested).length > 0) safe[key] = nested;
      } else {
        const scalar = safeResponseScalar(key, raw);
        if (scalar !== undefined) safe[key] = scalar;
      }
      continue;
    }
    if (SAFE_RESPONSE_CONTAINERS.has(normalizedKey)) {
      const nested = sanitizeProviderResponse(raw, depth + 1);
      if (nested && Object.keys(nested).length > 0) safe[key] = nested;
    }
  }
  return Object.keys(safe).length > 0 ? safe : null;
}

function sanitizePostResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const safe = {};
  for (const key of SAFE_RESULT_BOOLEAN_FIELDS) {
    if (typeof value[key] === 'boolean') safe[key] = value[key];
  }
  for (const key of SAFE_RESULT_NUMBER_FIELDS) {
    if (Number.isSafeInteger(value[key]) && value[key] >= 0) safe[key] = value[key];
  }
  for (const key of SAFE_RESULT_STRING_FIELDS) {
    if (typeof value[key] === 'string' && value[key].trim()) {
      safe[key] = scrubEvidenceText(value[key], key === 'reason' ? 500 : 120);
    }
  }
  const response = sanitizeProviderResponse(value.response);
  if (response) safe.response = response;
  return Object.keys(safe).length > 0 ? safe : null;
}

function sanitizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history.slice(-POST_HISTORY_LIMIT).flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const event = scrubEvidenceText(entry.event || 'event', 64).trim() || 'event';
    const safe = { event };
    if (entry.at) safe.at = scrubEvidenceText(entry.at, 80);
    if (entry.detail) safe.detail = scrubEvidenceText(entry.detail, 300);
    return [safe];
  });
}

/**
 * Append one evidence entry to a post's history array, returning a new
 * capped array. Entries are plain JSON ({ at, event, detail? }) so they
 * survive Firestore round-trips and render directly in the view. Callers
 * must only pass already-safe strings — the same redacted reasons that go
 * into errorMessage/lastResult — never raw API responses or tokens.
 */
function appendHistoryEntry(history, event, detail) {
  const entry = { at: new Date().toISOString(), event: scrubEvidenceText(event || 'event', 64) };
  const cleanDetail = scrubEvidenceText(detail, 300).trim();
  if (cleanDetail) entry.detail = cleanDetail.slice(0, 300);
  const base = sanitizeHistory(history);
  return [...base, entry].slice(-POST_HISTORY_LIMIT);
}

function toTimestampOrNull(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : Timestamp.fromDate(date);
}

function toIsoOrNull(value) {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  return null;
}

function normalizeQueueStatus(value) {
  const status = String(value || 'pending').trim().toLowerCase() || 'pending';
  // Compatibility for documents created before the Firestore scheduler
  // renamed the in-flight state. Do not manufacture provider states here.
  return status === 'publishing' ? 'processing' : status;
}

/**
 * Firestore document -> the flat "post" shape the rest of the app already
 * knows how to read. `doc` is anything with `.id` and `.data()` — a real
 * DocumentSnapshot/QueryDocumentSnapshot works directly.
 *
 * `scheduledAt` stays an ISO string here on purpose: every existing call
 * site (routes.js, tiktok.js, the EJS view) does `new Date(post.scheduledAt)`
 * or just prints it, so keeping the in-app shape unchanged means none of
 * that code needs to be touched. Only this file and the Firestore documents
 * themselves use the canonical `scheduledAt` Timestamp field.
 */
function postFromDoc(doc) {
  const data = doc.data() || {};
  const id = doc.id;
  // Provider compatibility rule: a MISSING legacy provider value normalizes
  // to TikTok; an EXPLICIT stored value is preserved as-is (even when
  // unknown) so consumers can reject it instead of silently treating it as
  // TikTok. providerSource records which case applied.
  const explicitProvider = String(data.provider || data.platform || '').trim().toLowerCase();
  const provider = explicitProvider || 'tiktok';
  const accountId = data.accountId || (provider === 'tiktok'
    ? (data.tiktokAccountId || data.tiktokOpenId || data.open_id || '')
    : '');
  const tiktokOpenId = provider === 'tiktok'
    ? (data.tiktokOpenId || data.open_id || (accountId !== 'legacy' ? accountId : ''))
    : '';
  const lastResult = sanitizePostResult(data.lastResult);
  const history = sanitizeHistory(data.history);

  return {
    id,
    userId: data.userId || DEFAULT_USER_ID,
    // Part 4 workspace identity. Legacy records deliberately remain empty
    // here; the verified active-workspace resolver decides whether a
    // user-owned legacy record may be normalized for a given read.
    workspaceId: String(data.workspaceId || '').trim(),
    platform: data.platform || data.provider || 'tiktok',
    provider,
    providerSource: explicitProvider ? 'explicit' : 'legacy_default',
    // Canonical connected-account identity. New writes store it; legacy
    // TikTok-assigned records derive the same composite so both read paths
    // resolve one identity without a migration.
    connectedAccountId: data.connectedAccountId
      || (accountId && accountId !== 'legacy' ? `${provider}:${accountId}` : ''),
    creationSource: data.creationSource || '',
    createdBy: data.createdBy || '',
    correlationId: data.correlationId || '',
    accountId: accountId || 'legacy',
    tiktokOpenId,
    username: data.username || data.tiktokUsername || '',
    accountAssignment: accountId ? 'assigned' : 'legacy',
    // Parent campaign link for multi-channel scheduling. Older documents
    // have no campaignId; '' keeps them rendering as standalone jobs.
    campaignId: data.campaignId || '',
    // Max Scheduler metadata. Older documents (and legacy autoSchedulePosts
    // jobs) have none of these; the defaults keep them rendering exactly as
    // they did before this field existed.
    campaignStartAt: toIsoOrNull(data.campaignStartAt),
    channelOffsetMinutes: Number.isFinite(Number(data.channelOffsetMinutes)) ? Number(data.channelOffsetMinutes) : 0,
    channelOrder: Number.isFinite(Number(data.channelOrder)) ? Number(data.channelOrder) : 0,
    // Daily-series metadata. This is intentionally persisted now even
    // before pause/resume/edit-series controls exist, so every generated job
    // remains attributable to one bounded recurring campaign.
    seriesId: String(data.seriesId || '').trim(),
    seriesFrequency: String(data.seriesFrequency || '').trim(),
    seriesStartDate: String(data.seriesStartDate || '').trim(),
    seriesEndDate: String(data.seriesEndDate || '').trim(),
    seriesOccurrenceIndex: Number.isInteger(Number(data.seriesOccurrenceIndex)) ? Number(data.seriesOccurrenceIndex) : null,
    seriesOccurrenceCount: Number.isInteger(Number(data.seriesOccurrenceCount)) ? Number(data.seriesOccurrenceCount) : 0,
    seriesSourceCount: Number.isInteger(Number(data.seriesSourceCount)) ? Number(data.seriesSourceCount) : 0,
    seriesTimezone: String(data.seriesTimezone || '').trim(),
    seriesOccurrenceDate: String(data.seriesOccurrenceDate || '').trim(),
    title: data.title || data.postTitle || data.name || data.originalName || data.fileName || '',
    originalName: data.originalName || '',
    fileName: data.fileName || '',
    mimeType: data.mimeType || '',
    mediaType: data.mediaType || 'photo',
    mediaUrl: data.mediaUrl || data.mediaPath || '',
    mediaPath: data.mediaUrl || data.mediaPath || '',
    videoPath: data.videoPath || '',
    imagePath: data.imagePath || '',
    mediaStoragePath: data.mediaStoragePath || '',
    cloudinaryPublicId: data.cloudinaryPublicId || '',
    cloudinaryResourceType: data.cloudinaryResourceType || '',
    sharedMediaAsset: Boolean(data.sharedMediaAsset),
    caption: data.caption || '',
    hashtags: data.hashtags || '',
    publicMediaUrl: data.publicMediaUrl || data.mediaUrl || data.publicImageUrl || '',
    publicImageUrl: data.publicImageUrl || '',
    thumbnailUrl: data.thumbnailUrl || data.thumbnail || data.coverUrl || data.imagePath || data.publicImageUrl || '',
    mediaSource: data.mediaSource || (data.cloudinaryPublicId ? 'cloudinary' : (data.mediaStoragePath ? 'firebase_storage' : (data.publicMediaUrl || data.publicImageUrl ? 'public_url' : 'legacy_local'))),
    autoMusicApplied: Boolean(data.autoMusicApplied),
    musicTrackId: data.musicTrackId || '',
    musicCategory: data.musicCategory || '',
    musicMood: data.musicMood || '',
    storageFallback: Boolean(data.storageFallback),
    instagramMediaUrl: data.instagramMediaUrl || '',
    privacyLevel: data.privacyLevel || 'SELF_ONLY',
    scheduledAt: toIsoOrNull(data.scheduledAt || data.scheduledTimeUTC),
    status: normalizeQueueStatus(data.status),
    // Human-approval gate (see scheduler.js isExplicitlyApproved). A post
    // is a draft until approvedAt holds a real Timestamp; anything
    // missing, malformed, or corrupted maps to "not approved" on purpose.
    approvedAt: toIsoOrNull(data.approvedAt),
    approvedBy: typeof data.approvedBy === 'string' ? data.approvedBy : '',
    approved: Boolean(toIsoOrNull(data.approvedAt)),
    approvalState: toIsoOrNull(data.approvedAt) ? 'approved' : 'unapproved',
    // Redacted evidence log: [{ at, event, detail? }, ...]
    history,
    fileSize: Number(data.fileSize || 0),
    duplicateWarning: data.duplicateWarning || '',
    order: Number(data.order || 0),
    createdAt: toIsoOrNull(data.createdAt),
    updatedAt: toIsoOrNull(data.updatedAt),
    postedAt: toIsoOrNull(data.postedAt),
    publishId: data.publishId || '',
    readyAt: toIsoOrNull(data.readyAt),
    // Provider-reported state beyond the queue lifecycle (e.g. YouTube
    // 'uploaded_private'). '' means the provider reported nothing.
    providerStatus: data.providerStatus || '',
    // Bounded provider-specific metadata (Part 3: YouTube). Explicit
    // allowlist copy — whatever lands in the document, only these safe
    // fields reach the app/UI/Runtime, never anything credential-shaped.
    providerMetadata: data.providerMetadata && typeof data.providerMetadata === 'object'
      && data.providerMetadata.youtube && typeof data.providerMetadata.youtube === 'object'
      ? {
          youtube: {
            title: String(data.providerMetadata.youtube.title || ''),
            description: String(data.providerMetadata.youtube.description || ''),
            privacyStatus: String(data.providerMetadata.youtube.privacyStatus || 'private'),
            notifySubscribers: Boolean(data.providerMetadata.youtube.notifySubscribers)
          }
        }
      : null,
    lastResult,
    lastError: (lastResult && lastResult.reason) || '',
    // Only canonical, scrubbed history is exposed as operational evidence.
    // Legacy arbitrary logs/events may contain raw provider payloads.
    logs: history,
    lastInstagramResult: sanitizePostResult(data.lastInstagramResult),
    disableComment: Boolean(data.disableComment),
    disableDuet: Boolean(data.disableDuet),
    disableStitch: Boolean(data.disableStitch),
    contentDisclosure: Boolean(data.contentDisclosure),
    yourBrand: Boolean(data.yourBrand),
    brandedContent: Boolean(data.brandedContent),
    // Agent Runtime scheduling metadata (runtimeControlRoutes.js). Older
    // documents have neither field; '' keeps them out of idempotency lookups.
    idempotencyKey: data.idempotencyKey || data.runtimeIdempotencyKey || '',
    runtimeIdempotencyKey: data.runtimeIdempotencyKey || data.idempotencyKey || '',
    runtimeScheduledBy: data.runtimeScheduledBy || '',
    // Usage linkage contains identifiers and lifecycle state only. Counter
    // documents, subscription overrides, and billing identifiers never ride
    // on queue/API projections.
    usageReservationId: String(data.usageReservationId || '').trim(),
    usageCycleId: String(data.usageCycleId || '').trim(),
    usageState: String(data.usageState || '').trim(),
    // Scheduler-only bookkeeping. Harmless to expose; nothing in routes.js
    // or the view currently reads these, but scheduler.js does.
    lockedAt: toIsoOrNull(data.lockedAt),
    lockedBy: data.lockedBy || null,
    claimAttempts: Number(data.claimAttempts || 0)
  };
}

/**
 * The reverse direction: a patch object shaped like what routes.js builds
 * today (e.g. { caption, scheduledAt, disableComment, ... }) -> the field
 * names/types Firestore actually stores.
 */
function mapPatchToFirestore(patch) {
  const result = { ...patch };

  if ('lastResult' in result) result.lastResult = sanitizePostResult(result.lastResult);
  if ('lastInstagramResult' in result) result.lastInstagramResult = sanitizePostResult(result.lastInstagramResult);
  if ('history' in result) result.history = sanitizeHistory(result.history);

  if ('scheduledAt' in result) {
    result.scheduledAt = toTimestampOrNull(result.scheduledAt);
  }
  if ('postedAt' in result) {
    result.postedAt = toTimestampOrNull(result.postedAt);
  }
  if ('readyAt' in result) {
    result.readyAt = toTimestampOrNull(result.readyAt);
  }
  if ('approvedAt' in result) {
    result.approvedAt = toTimestampOrNull(result.approvedAt);
  }

  return result;
}

module.exports = {
  DEFAULT_USER_ID,
  POST_HISTORY_LIMIT,
  appendHistoryEntry,
  toTimestampOrNull,
  toIsoOrNull,
  normalizeQueueStatus,
  scrubEvidenceText,
  sanitizeProviderResponse,
  sanitizePostResult,
  sanitizeHistory,
  postFromDoc,
  mapPatchToFirestore
};
