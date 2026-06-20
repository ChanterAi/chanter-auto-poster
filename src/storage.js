const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { DateTime } = require('luxon');
const config = require('./config');
const { postsCollection, configDoc, getFirestore, getFirebaseApp, Timestamp, FieldValue } = require('./firestore');
const { DEFAULT_USER_ID, postFromDoc, mapPatchToFirestore } = require('./postsMapper');

const defaultSettings = {
  dailyPostTime: '09:00',
  updatedAt: null
};

const defaultTikTokAuth = {
  connected: false,
  open_id: '',
  access_token: '',
  refresh_token: '',
  expires_at: null,
  scope: ''
};

const defaultInstagramAuth = {
  connected: false,
  source: '',
  user_id: '',
  access_token: '',
  token_type: '',
  expires_at: null,
  scope: '',
  facebook_page_id: '',
  facebook_page_name: '',
  facebook_page_access_token: '',
  instagram_business_account_id: '',
  instagram_username: '',
  account_type: '',
  profile_picture_url: '',
  media_count: null,
  followers_count: null,
  connected_at: null,
  updated_at: null
};

const STORAGE_UPLOAD_ATTEMPTS = Math.max(1, Number(config.firebase.storageUploadAttempts) || 3);
const STORAGE_RETRY_BASE_MS = Math.max(100, Number(config.firebase.storageRetryBaseMs) || 500);
const STORAGE_RESUMABLE_THRESHOLD_BYTES = Math.max(
  0,
  Number(config.firebase.storageResumableThresholdBytes) || 10 * 1024 * 1024
);

function getErrorChain(error) {
  const chain = [];
  const queue = [error];
  const seen = new Set();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || typeof current !== 'object' || seen.has(current)) continue;
    seen.add(current);
    chain.push(current);
    if (current.cause) queue.push(current.cause);
    if (current.error) queue.push(current.error);
    if (Array.isArray(current.errors)) queue.push(...current.errors);
  }

  return chain;
}

function isPrematureCloseError(error) {
  return getErrorChain(error).some((item) => {
    const code = String(item.code || item.errno || '').toUpperCase();
    const message = String(item.message || '').toUpperCase();
    return code === 'ERR_STREAM_PREMATURE_CLOSE' ||
      message.includes('ERR_STREAM_PREMATURE_CLOSE') ||
      message.includes('PREMATURE CLOSE');
  });
}

function storageErrorCode(error) {
  const match = getErrorChain(error).find((item) => item.code || item.errno);
  return String((match && (match.code || match.errno)) || 'STORAGE_UPLOAD_FAILED');
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function uploadWithRetry(upload) {
  let lastError;

  for (let attempt = 1; attempt <= STORAGE_UPLOAD_ATTEMPTS; attempt += 1) {
    try {
      return await upload();
    } catch (error) {
      lastError = error;
      const retryable = isPrematureCloseError(error);
      const code = retryable ? 'ERR_STREAM_PREMATURE_CLOSE' : storageErrorCode(error);

      if (!retryable || attempt === STORAGE_UPLOAD_ATTEMPTS) {
        console.error('[firebase-storage] upload failed', {
          attempts: attempt,
          code,
          retryable
        });
        const cleanError = new Error(
          retryable
            ? `Firebase Storage upload failed after ${attempt} attempts because the Google OAuth connection closed early`
            : `Firebase Storage upload failed (${code})`
        );
        cleanError.code = code;
        cleanError.status = 503;
        throw cleanError;
      }

      const delayMs = STORAGE_RETRY_BASE_MS * (2 ** (attempt - 1));
      console.warn('[firebase-storage] OAuth response closed early; retrying upload', {
        attempt,
        maxAttempts: STORAGE_UPLOAD_ATTEMPTS,
        delayMs
      });
      await wait(delayMs);
    }
  }

  throw lastError;
}

// ── Bootstrap ────────────────────────────────────────────────────────────

async function ensureStorage() {
  // Firestore needs no directories on disk. This now (a) fails fast and
  // loud at boot if the Admin SDK credentials are missing/bad, instead of
  // booting a server that 500s on the first request, and (b) seeds the
  // singleton config docs the app expects to always exist, mirroring the
  // old "create default JSON files on first run" behaviour.
  const db = getFirestore();
  await db.collection('config').limit(1).get();

  await Promise.all([
    ensureConfigDoc('settings', defaultSettings),
    ensureConfigDoc('tiktokAuth', defaultTikTokAuth),
    ensureConfigDoc('instagramAuth', defaultInstagramAuth)
  ]);
}

async function ensureConfigDoc(name, defaults) {
  const ref = configDoc(name);
  const snap = await ref.get();
  if (!snap.exists) {
    await ref.set(defaults);
  }
}

// ── Posts ────────────────────────────────────────────────────────────────

function comparePosts(a, b) {
  const orderDiff = Number(a.order || 0) - Number(b.order || 0);
  if (orderDiff !== 0) return orderDiff;
  return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
}

async function getPosts(userId) {
  const ownerId = userId || DEFAULT_USER_ID;
  const snapshot = await postsCollection().where('userId', '==', ownerId).get();
  return snapshot.docs.map(postFromDoc).sort(comparePosts);
}

async function getPost(userId, id) {
  if (!id) return null;
  const ownerId = userId || DEFAULT_USER_ID;
  const snap = await postsCollection().doc(id).get();
  if (!snap.exists) return null;
  if ((snap.data().userId || DEFAULT_USER_ID) !== ownerId) return null;
  return postFromDoc(snap);
}

async function getMaxOrder(userId) {
  const snapshot = await postsCollection()
    .where('userId', '==', userId)
    .select('order')
    .get();
  return snapshot.docs.reduce((max, doc) => Math.max(max, Number(doc.data().order || 0)), 0);
}

function getUploadMediaType(file) {
  const mime = String(file.mimetype || '').toLowerCase();
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('image/')) return 'photo';

  const extension = path.extname(file.originalname || file.filename || '').toLowerCase();
  if (['.mp4', '.mov', '.webm'].includes(extension)) return 'video';
  return 'photo';
}

function defaultExtension(file) {
  const mime = String(file.mimetype || '').toLowerCase();
  if (mime === 'video/mp4') return '.mp4';
  if (mime === 'video/quicktime') return '.mov';
  if (mime === 'video/webm') return '.webm';
  if (mime === 'image/png') return '.png';
  if (mime === 'image/webp') return '.webp';
  return path.extname(file.originalname || '').toLowerCase() || '.jpg';
}

function getStoredFileName(file) {
  return file.filename || `${Date.now()}-${randomUUID()}${defaultExtension(file)}`;
}

async function saveUploadToCloud(file, fileName) {
  if (!file || (!file.path && !file.buffer)) {
    throw new Error('Upload file is missing its temporary content');
  }

  const mediaStoragePath = `uploads/${fileName}`;
  const bucket = getFirebaseApp().storage().bucket();
  const object = bucket.file(mediaStoragePath);
  const contentType = file.mimetype || 'application/octet-stream';
  const uploadSize = Number(file.size || (file.path && fs.statSync(file.path).size) || 0);
  const resumable = uploadSize > STORAGE_RESUMABLE_THRESHOLD_BYTES;
  const downloadToken = randomUUID();
  const metadata = {
    contentType,
    metadata: { firebaseStorageDownloadTokens: downloadToken }
  };

  await uploadWithRetry(async () => {
    if (file.buffer) {
      await object.save(file.buffer, {
        resumable,
        metadata
      });
      return;
    }

    await bucket.upload(file.path, {
      destination: mediaStoragePath,
      resumable,
      metadata
    });
  });

  const mediaUrl =
    `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(bucket.name)}` +
    `/o/${encodeURIComponent(mediaStoragePath)}?alt=media&token=${encodeURIComponent(downloadToken)}`;

  return { mediaStoragePath, mediaUrl };
}

async function deleteCloudObject(mediaStoragePath) {
  if (!mediaStoragePath) return;
  try {
    await getFirebaseApp().storage().bucket().file(mediaStoragePath).delete({ ignoreNotFound: true });
  } catch (error) {
    console.warn('[storage] failed to delete cloud media', mediaStoragePath, error.message);
  }
}

function cleanupLocalUpload(file) {
  if (!file || !file.path) return;
  try {
    const uploadPath = path.resolve(file.path);
    const uploadsRoot = path.resolve(config.uploadsDir);
    if (uploadPath.startsWith(uploadsRoot)) fs.unlinkSync(uploadPath);
  } catch (error) {
    // The durable copy already lives in Firebase Storage; local cleanup is best effort.
  }
}

function getPublicMediaType(mediaUrl) {
  try {
    const pathname = new URL(mediaUrl).pathname.toLowerCase();
    return ['.mp4', '.mov', '.webm'].some((extension) => pathname.endsWith(extension))
      ? 'video'
      : 'photo';
  } catch (error) {
    return 'photo';
  }
}

function isPublicHttpsUrl(mediaUrl) {
  try {
    return new URL(mediaUrl).protocol === 'https:';
  } catch (error) {
    return false;
  }
}

function getPublicMediaName(mediaUrl) {
  try {
    return path.basename(new URL(mediaUrl).pathname) || 'public-media';
  } catch (error) {
    return 'public-media';
  }
}

function getPublicMediaMimeType(mediaType, mediaUrl) {
  const pathname = String(mediaUrl || '').toLowerCase();
  if (pathname.includes('.png')) return 'image/png';
  if (pathname.includes('.webp')) return 'image/webp';
  if (pathname.includes('.mov')) return 'video/quicktime';
  if (pathname.includes('.webm')) return 'video/webm';
  return mediaType === 'video' ? 'video/mp4' : 'image/jpeg';
}

async function addUploadedPosts(userId, files, defaults = {}) {
  const ownerId = userId || DEFAULT_USER_ID;
  const uploadFiles = Array.isArray(files) ? files : [];
  const fallbackUrl = String(defaults.publicMediaUrl || defaults.publicImageUrl || '').trim();
  if (fallbackUrl && !isPublicHttpsUrl(fallbackUrl)) {
    const error = new Error('Public Media URL must be a valid HTTPS URL');
    error.status = 400;
    throw error;
  }
  const sources = uploadFiles.length > 0 ? uploadFiles : (fallbackUrl ? [null] : []);
  if (sources.length === 0) {
    const error = new Error('Choose a media file or enter a public HTTPS media URL');
    error.status = 400;
    throw error;
  }

  let order = (await getMaxOrder(ownerId)) + 1;
  const now = Timestamp.now();
  const db = getFirestore();
  const batch = db.batch();
  const created = [];
  const storedObjects = [];
  let committed = false;

  try {
    for (const file of sources) {
      const mediaType = file ? getUploadMediaType(file) : getPublicMediaType(fallbackUrl);
      const fileName = file ? getStoredFileName(file) : getPublicMediaName(fallbackUrl);
      let mediaStoragePath = '';
      let mediaUrl = fallbackUrl;
      let storageFallback = false;

      if (file) {
        try {
          const uploaded = await saveUploadToCloud(file, fileName);
          mediaStoragePath = uploaded.mediaStoragePath;
          mediaUrl = uploaded.mediaUrl;
          storedObjects.push(mediaStoragePath);
        } catch (error) {
          if (!fallbackUrl || uploadFiles.length !== 1) throw error;
          storageFallback = true;
          console.warn('[firebase-storage] using submitted public media URL after upload failure', {
            code: error.code || 'STORAGE_UPLOAD_FAILED'
          });
        }
      }

      const ref = postsCollection().doc(randomUUID());
      const publicMediaUrl = mediaStoragePath ? mediaUrl : fallbackUrl;

      const data = {
        userId: ownerId,
        platform: 'tiktok',
        originalName: file ? file.originalname : fileName,
        fileName,
        mimeType: (file && file.mimetype) || getPublicMediaMimeType(mediaType, publicMediaUrl),
        mediaType,
        mediaPath: mediaUrl,
        mediaStoragePath,
        videoPath: mediaType === 'video' ? mediaUrl : '',
        imagePath: mediaType === 'photo' ? mediaUrl : '',
        publicMediaUrl,
        mediaSource: mediaStoragePath ? 'firebase_storage' : 'public_url',
        storageFallback,
        caption: String(defaults.caption || '').trim(),
        hashtags: String(defaults.hashtags || '').trim(),
        publicImageUrl: mediaType === 'photo' ? publicMediaUrl : '',
        instagramMediaUrl: String(defaults.instagramMediaUrl || publicMediaUrl).trim(),
        privacyLevel:
          String(defaults.privacyLevel || config.tiktok.privacyLevel || 'SELF_ONLY').trim() || 'SELF_ONLY',
        scheduledTimeUTC: null,
        status: 'pending',
        order: order++,
        createdAt: now,
        updatedAt: now,
        postedAt: null,
        readyAt: null,
        lastResult: null,
        lastInstagramResult: null,
        disableComment: false,
        disableDuet: false,
        disableStitch: false,
        contentDisclosure: false,
        yourBrand: false,
        brandedContent: false,
        lockedAt: null,
        lockedBy: null,
        claimAttempts: 0
      };

      batch.set(ref, data);
      created.push({ ref, data });
    }

    await batch.commit();
    committed = true;
    return created.map(({ ref, data }) => postFromDoc({ id: ref.id, data: () => data }));
  } finally {
    uploadFiles.forEach(cleanupLocalUpload);
    if (!committed) {
      await Promise.all(storedObjects.map(deleteCloudObject));
    }
  }
}

async function updatePost(userId, id, patch) {
  const ownerId = userId || DEFAULT_USER_ID;
  const ref = postsCollection().doc(id);
  const snap = await ref.get();
  if (!snap.exists) return null;
  if ((snap.data().userId || DEFAULT_USER_ID) !== ownerId) return null;

  await ref.update({ ...mapPatchToFirestore(patch), updatedAt: FieldValue.serverTimestamp() });
  const updated = await ref.get();
  return postFromDoc(updated);
}

async function deletePost(userId, id) {
  const ownerId = userId || DEFAULT_USER_ID;
  const ref = postsCollection().doc(id);
  const snap = await ref.get();
  if (!snap.exists) return false;
  if ((snap.data().userId || DEFAULT_USER_ID) !== ownerId) return false;

  const data = snap.data();
  const fileName = data.fileName;
  const mediaStoragePath = data.mediaStoragePath;
  await ref.delete();
  await deleteCloudObject(mediaStoragePath);

  if (fileName) {
    const uploadPath = path.resolve(config.uploadsDir, fileName);
    if (uploadPath.startsWith(path.resolve(config.uploadsDir))) {
      try {
        fs.unlinkSync(uploadPath);
      } catch (error) {
        // The queue item is still removed even if the local media file is
        // already gone — expected after a Render restart wiped the disk.
      }
    }
  }

  return true;
}

async function movePost(userId, id, direction) {
  const ownerId = userId || DEFAULT_USER_ID;
  const posts = await getPosts(ownerId);
  const index = posts.findIndex((post) => post.id === id);
  const targetIndex = direction === 'up' ? index - 1 : index + 1;

  if (index < 0 || targetIndex < 0 || targetIndex >= posts.length) {
    return false;
  }

  const db = getFirestore();
  const batch = db.batch();
  const now = FieldValue.serverTimestamp();
  batch.update(postsCollection().doc(posts[index].id), { order: posts[targetIndex].order, updatedAt: now });
  batch.update(postsCollection().doc(posts[targetIndex].id), { order: posts[index].order, updatedAt: now });
  await batch.commit();
  return true;
}

async function autoSchedulePosts(userId, postIds) {
  const ownerId = userId || DEFAULT_USER_ID;
  const idSet = new Set(postIds);
  const posts = await getPosts(ownerId);
  const settings = await getSettings();
  let nextDate = getNextAvailableDate(posts, settings.dailyPostTime, idSet);

  const db = getFirestore();
  const batch = db.batch();
  let count = 0;

  for (const post of posts) {
    if (!idSet.has(post.id) || post.status !== 'pending') continue;
    batch.update(postsCollection().doc(post.id), {
      scheduledTimeUTC: Timestamp.fromDate(nextDate),
      updatedAt: FieldValue.serverTimestamp()
    });
    nextDate = addDaysAtTime(nextDate, 1, settings.dailyPostTime);
    count += 1;
  }

  if (count > 0) await batch.commit();
  return count;
}

async function reschedulePendingQueue(userId) {
  const ownerId = userId || DEFAULT_USER_ID;
  const posts = await getPosts(ownerId);
  const settings = await getSettings();
  let nextDate = tomorrowAtTime(settings.dailyPostTime);

  const db = getFirestore();
  const batch = db.batch();
  let count = 0;

  for (const post of posts) {
    if (post.status !== 'pending') continue;
    batch.update(postsCollection().doc(post.id), {
      scheduledTimeUTC: Timestamp.fromDate(nextDate),
      updatedAt: FieldValue.serverTimestamp()
    });
    nextDate = addDaysAtTime(nextDate, 1, settings.dailyPostTime);
    count += 1;
  }

  if (count > 0) await batch.commit();
  return count;
}

function getNextAvailableDate(posts, dailyPostTime, newlyCreatedIds) {
  const tomorrow = tomorrowAtTime(dailyPostTime);
  const futureScheduledTimes = posts
    .filter((post) => !newlyCreatedIds.has(post.id))
    .filter((post) => post.status === 'pending' && post.scheduledAt)
    .map((post) => new Date(post.scheduledAt))
    .filter((date) => date.getTime() >= tomorrow.getTime())
    .map((date) => date.getTime());

  if (futureScheduledTimes.length === 0) return tomorrow;

  const latest = new Date(Math.max(...futureScheduledTimes));
  return addDaysAtTime(latest, 1, dailyPostTime);
}

function tomorrowAtTime(time) {
  return zonedDayAtTime(DateTime.now().setZone(getScheduleTimeZone()).plus({ days: 1 }), time);
}

function addDaysAtTime(date, days, time) {
  const base = DateTime.fromJSDate(date, { zone: 'utc' }).setZone(getScheduleTimeZone()).plus({ days });
  return zonedDayAtTime(base, time);
}

function zonedDayAtTime(day, time) {
  const zone = getScheduleTimeZone();
  const { hours, minutes } = parseDailyTime(time);
  return day
    .setZone(zone)
    .set({ hour: hours, minute: minutes, second: 0, millisecond: 0 })
    .toUTC()
    .toJSDate();
}

function parseDailyTime(time) {
  const [hours, minutes] = String(time || '09:00')
    .split(':')
    .map((part) => Number(part));

  return {
    hours: Number.isInteger(hours) && hours >= 0 && hours <= 23 ? hours : 9,
    minutes: Number.isInteger(minutes) && minutes >= 0 && minutes <= 59 ? minutes : 0
  };
}

function getScheduleTimeZone() {
  const zone = config.appTimeZone || 'UTC';
  return DateTime.now().setZone(zone).isValid ? zone : 'UTC';
}

async function getCounts(userId) {
  const posts = await getPosts(userId);
  return posts.reduce(
    (counts, post) => {
      counts.total += 1;
      counts[post.status] = (counts[post.status] || 0) + 1;
      return counts;
    },
    { total: 0, pending: 0, processing: 0, ready: 0, posted: 0, failed: 0 }
  );
}

// ── Settings & integration auth ─────────────────────────────────────────
// Still a single shared doc each — today there's only one TikTok account
// and one Instagram account for the whole app, same as before. The
// difference from the old storage.js is just *where* they live: Firestore
// instead of data/*.json, so a Render restart can't erase them. If you
// later want each user to connect their own TikTok/Instagram account,
// these would move under a per-user path — that's a separate feature.

async function getSettings() {
  const snap = await configDoc('settings').get();
  return { ...defaultSettings, ...(snap.exists ? snap.data() : {}) };
}

async function saveSettings(settings) {
  const next = { ...(await getSettings()), ...settings, updatedAt: new Date().toISOString() };
  await configDoc('settings').set(next);
  return next;
}

async function getTikTokAuth() {
  const snap = await configDoc('tiktokAuth').get();
  return { ...defaultTikTokAuth, ...(snap.exists ? snap.data() : {}) };
}

async function saveTikTokAuth(auth) {
  const next = {
    ...defaultTikTokAuth,
    ...auth,
    connected: Boolean(auth.connected && auth.access_token)
  };
  await configDoc('tiktokAuth').set(next);
  return next;
}

async function clearTikTokAuth() {
  await configDoc('tiktokAuth').set(defaultTikTokAuth);
  return defaultTikTokAuth;
}

async function getInstagramAuth() {
  const snap = await configDoc('instagramAuth').get();
  return { ...defaultInstagramAuth, ...(snap.exists ? snap.data() : {}) };
}

async function saveInstagramAuth(auth) {
  const previous = await getInstagramAuth();
  const now = new Date().toISOString();
  const next = {
    ...defaultInstagramAuth,
    ...previous,
    ...auth,
    connected: Boolean(auth.connected && (auth.access_token || previous.access_token)),
    connected_at: previous.connected_at || auth.connected_at || now,
    updated_at: now
  };
  await configDoc('instagramAuth').set(next);
  return next;
}

async function clearInstagramAuth() {
  await configDoc('instagramAuth').set(defaultInstagramAuth);
  return defaultInstagramAuth;
}

module.exports = {
  ensureStorage,
  getPosts,
  getPost,
  getSettings,
  saveSettings,
  getTikTokAuth,
  saveTikTokAuth,
  clearTikTokAuth,
  getInstagramAuth,
  saveInstagramAuth,
  clearInstagramAuth,
  addUploadedPosts,
  updatePost,
  deletePost,
  movePost,
  autoSchedulePosts,
  reschedulePendingQueue,
  getCounts,
  DEFAULT_USER_ID
};
