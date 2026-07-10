'use strict';

const config = require('./config');
const { Timestamp } = require('./firestore');

const DEFAULT_USER_ID = config.defaultUserId;

// Evidence log cap. Publish attempts are already bounded by
// SCHEDULER_MAX_CLAIM_ATTEMPTS, so this is a belt-and-braces limit that
// keeps a single document from growing without bound no matter what.
const POST_HISTORY_LIMIT = 50;

/**
 * Append one evidence entry to a post's history array, returning a new
 * capped array. Entries are plain JSON ({ at, event, detail? }) so they
 * survive Firestore round-trips and render directly in the view. Callers
 * must only pass already-safe strings — the same redacted reasons that go
 * into errorMessage/lastResult — never raw API responses or tokens.
 */
function appendHistoryEntry(history, event, detail) {
  const entry = { at: new Date().toISOString(), event: String(event || 'event').slice(0, 64) };
  const cleanDetail = String(detail || '').trim();
  if (cleanDetail) entry.detail = cleanDetail.slice(0, 300);
  const base = Array.isArray(history) ? history : [];
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
  const accountId = data.accountId || data.tiktokAccountId || data.tiktokOpenId || data.open_id || '';
  const tiktokOpenId = data.tiktokOpenId || data.open_id || (accountId !== 'legacy' ? accountId : '');
  // Provider compatibility rule: a MISSING legacy provider value normalizes
  // to TikTok; an EXPLICIT stored value is preserved as-is (even when
  // unknown) so consumers can reject it instead of silently treating it as
  // TikTok. providerSource records which case applied.
  const explicitProvider = String(data.provider || data.platform || '').trim().toLowerCase();
  const provider = explicitProvider || 'tiktok';

  return {
    id,
    userId: data.userId || DEFAULT_USER_ID,
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
    history: Array.isArray(data.history) ? data.history : [],
    fileSize: Number(data.fileSize || 0),
    duplicateWarning: data.duplicateWarning || '',
    order: Number(data.order || 0),
    createdAt: toIsoOrNull(data.createdAt),
    updatedAt: toIsoOrNull(data.updatedAt),
    postedAt: toIsoOrNull(data.postedAt),
    publishId: data.publishId || '',
    readyAt: toIsoOrNull(data.readyAt),
    lastResult: data.lastResult || null,
    lastError: data.lastError || data.error || (data.lastResult && (data.lastResult.reason || data.lastResult.error || data.lastResult.message)) || '',
    logs: data.logs || data.events || data.history || [],
    lastInstagramResult: data.lastInstagramResult || null,
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
  postFromDoc,
  mapPatchToFirestore
};
