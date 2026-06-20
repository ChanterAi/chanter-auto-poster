'use strict';

const config = require('./config');
const { Timestamp } = require('./firestore');

const DEFAULT_USER_ID = config.defaultUserId;

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

/**
 * Firestore document -> the flat "post" shape the rest of the app already
 * knows how to read. `doc` is anything with `.id` and `.data()` — a real
 * DocumentSnapshot/QueryDocumentSnapshot works directly.
 *
 * `scheduledAt` stays an ISO string here on purpose: every existing call
 * site (routes.js, tiktok.js, the EJS view) does `new Date(post.scheduledAt)`
 * or just prints it, so keeping the in-app shape unchanged means none of
 * that code needs to be touched. Only this file and the Firestore documents
 * themselves use the spec's `scheduledTimeUTC` Timestamp field.
 */
function postFromDoc(doc) {
  const data = doc.data() || {};
  const id = doc.id;

  return {
    id,
    userId: data.userId || DEFAULT_USER_ID,
    platform: data.platform || 'tiktok',
    originalName: data.originalName || '',
    fileName: data.fileName || '',
    mimeType: data.mimeType || '',
    mediaType: data.mediaType || 'photo',
    mediaPath: data.mediaPath || '',
    videoPath: data.videoPath || '',
    imagePath: data.imagePath || '',
    mediaStoragePath: data.mediaStoragePath || '',
    caption: data.caption || '',
    hashtags: data.hashtags || '',
    publicMediaUrl: data.publicMediaUrl || data.publicImageUrl || '',
    publicImageUrl: data.publicImageUrl || '',
    mediaSource: data.mediaSource || (data.mediaStoragePath ? 'firebase_storage' : (data.publicMediaUrl || data.publicImageUrl ? 'public_url' : 'legacy_local')),
    storageFallback: Boolean(data.storageFallback),
    instagramMediaUrl: data.instagramMediaUrl || '',
    privacyLevel: data.privacyLevel || 'SELF_ONLY',
    scheduledAt: toIsoOrNull(data.scheduledTimeUTC),
    status: data.status || 'pending',
    order: Number(data.order || 0),
    createdAt: toIsoOrNull(data.createdAt),
    updatedAt: toIsoOrNull(data.updatedAt),
    postedAt: toIsoOrNull(data.postedAt),
    readyAt: toIsoOrNull(data.readyAt),
    lastResult: data.lastResult || null,
    lastInstagramResult: data.lastInstagramResult || null,
    disableComment: Boolean(data.disableComment),
    disableDuet: Boolean(data.disableDuet),
    disableStitch: Boolean(data.disableStitch),
    contentDisclosure: Boolean(data.contentDisclosure),
    yourBrand: Boolean(data.yourBrand),
    brandedContent: Boolean(data.brandedContent),
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
    result.scheduledTimeUTC = toTimestampOrNull(result.scheduledAt);
    delete result.scheduledAt;
  }
  if ('postedAt' in result) {
    result.postedAt = toTimestampOrNull(result.postedAt);
  }
  if ('readyAt' in result) {
    result.readyAt = toTimestampOrNull(result.readyAt);
  }

  return result;
}

module.exports = {
  DEFAULT_USER_ID,
  toTimestampOrNull,
  toIsoOrNull,
  postFromDoc,
  mapPatchToFirestore
};
