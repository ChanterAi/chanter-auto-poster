const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { DateTime } = require('luxon');
const config = require('./config');
const {
  postsCollection,
  tiktokAccountsCollection,
  configDoc,
  getFirestore,
  Timestamp,
  FieldValue
} = require('./firestore');
const { uploadMediaFile, destroyMediaAsset, checkCloudinaryHealth } = require('./cloudinary');
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

async function checkMediaStorageHealth({ writeTest = false } = {}) {
  return checkCloudinaryHealth({ writeTest });
}

// TikTok accounts

function tiktokAccountDocId(accountId) {
  return encodeURIComponent(String(accountId || '').trim());
}

function tiktokAccountFromDoc(doc) {
  const data = doc.data() || {};
  const accountId = String(data.accountId || data.open_id || '').trim();
  return {
    accountId,
    id: accountId,
    userId: data.userId || DEFAULT_USER_ID,
    platform: 'tiktok',
    open_id: data.open_id || accountId,
    tiktokOpenId: data.open_id || accountId,
    username: data.username || '',
    displayName: data.displayName || '',
    avatarUrl: data.avatarUrl || '',
    connected: Boolean(data.connected && data.access_token),
    access_token: data.access_token || '',
    refresh_token: data.refresh_token || '',
    expires_at: data.expires_at || null,
    scope: data.scope || '',
    createdAt: data.createdAt || null,
    updatedAt: data.updatedAt || null,
    connectedAt: data.connectedAt || null
  };
}

function timestampMillis(value) {
  if (value && typeof value.toMillis === 'function') return value.toMillis();
  if (value && typeof value.toDate === 'function') return value.toDate().getTime();
  const parsed = new Date(value || 0).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

async function saveTikTokAccount(userId, auth, profile = {}) {
  const ownerId = userId || DEFAULT_USER_ID;
  const accountId = String(auth.open_id || auth.accountId || '').trim();
  if (!accountId) throw new Error('TikTok OAuth did not return an open_id');

  const ref = tiktokAccountsCollection().doc(tiktokAccountDocId(accountId));
  const snap = await ref.get();
  if (snap.exists && (snap.data().userId || DEFAULT_USER_ID) !== ownerId) {
    throw new Error('TikTok account is already assigned to another app user');
  }

  const previous = snap.exists ? snap.data() : {};
  const now = Timestamp.now();
  const data = {
    userId: ownerId,
    platform: 'tiktok',
    accountId,
    open_id: accountId,
    username: profile.username || profile.creator_username || previous.username || '',
    displayName: profile.displayName || profile.creator_nickname || previous.displayName || '',
    avatarUrl: profile.avatarUrl || profile.creator_avatar_url || previous.avatarUrl || '',
    connected: Boolean(auth.access_token || previous.access_token),
    access_token: auth.access_token || previous.access_token || '',
    refresh_token: auth.refresh_token || previous.refresh_token || '',
    expires_at: auth.expires_at || previous.expires_at || null,
    scope: auth.scope || previous.scope || '',
    createdAt: previous.createdAt || now,
    connectedAt: now,
    updatedAt: now
  };
  await ref.set(data, { merge: true });
  return tiktokAccountFromDoc({ id: ref.id, data: () => data });
}

async function updateTikTokAccountProfile(userId, accountId, profile = {}) {
  const account = await getTikTokAccount(userId, accountId);
  if (!account) return null;
  const patch = {
    username: profile.username || profile.creator_username || account.username || '',
    displayName: profile.displayName || profile.creator_nickname || account.displayName || '',
    avatarUrl: profile.avatarUrl || profile.creator_avatar_url || account.avatarUrl || '',
    updatedAt: Timestamp.now()
  };
  await tiktokAccountsCollection().doc(tiktokAccountDocId(accountId)).set(patch, { merge: true });
  return { ...account, ...patch };
}

async function getTikTokAccounts(userId) {
  const ownerId = userId || DEFAULT_USER_ID;
  const snapshot = await tiktokAccountsCollection().where('userId', '==', ownerId).get();
  let accounts = snapshot.docs.map(tiktokAccountFromDoc);

  const legacy = await getTikTokAuth();
  if (
    legacy.connected && legacy.access_token && legacy.open_id &&
    !accounts.some((account) => account.accountId === legacy.open_id)
  ) {
    accounts.push(await saveTikTokAccount(ownerId, legacy));
  }

  return accounts.sort((a, b) => {
    if (a.connected !== b.connected) return a.connected ? -1 : 1;
    return timestampMillis(b.updatedAt) - timestampMillis(a.updatedAt);
  });
}

async function getTikTokAccount(userId, accountId) {
  const ownerId = userId || DEFAULT_USER_ID;
  const normalizedId = String(accountId || '').trim();
  if (!normalizedId || normalizedId === 'legacy') return null;
  const snap = await tiktokAccountsCollection().doc(tiktokAccountDocId(normalizedId)).get();
  if (snap.exists && (snap.data().userId || DEFAULT_USER_ID) === ownerId) {
    return tiktokAccountFromDoc(snap);
  }

  const legacy = await getTikTokAuth();
  if (legacy.open_id === normalizedId && legacy.connected && legacy.access_token) {
    return saveTikTokAccount(ownerId, legacy);
  }
  return null;
}

async function disconnectTikTokAccount(userId, accountId) {
  const account = await getTikTokAccount(userId, accountId);
  if (!account) return false;
  await tiktokAccountsCollection().doc(tiktokAccountDocId(accountId)).set({
    connected: false,
    access_token: '',
    refresh_token: '',
    expires_at: null,
    updatedAt: Timestamp.now()
  }, { merge: true });
  return true;
}

// ── Posts ────────────────────────────────────────────────────────────────

function comparePosts(a, b) {
  const orderDiff = Number(a.order || 0) - Number(b.order || 0);
  if (orderDiff !== 0) return orderDiff;
  return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
}

async function getPosts(userId, accountId) {
  const ownerId = userId || DEFAULT_USER_ID;
  const snapshot = await postsCollection().where('userId', '==', ownerId).get();
  const posts = snapshot.docs.map(postFromDoc);
  const normalizedAccountId = String(accountId || '').trim();
  return posts
    .filter((post) => !normalizedAccountId || post.accountId === normalizedAccountId)
    .sort(comparePosts);
}

async function getDashboardJobs(userId) {
  const ownerId = userId || DEFAULT_USER_ID;
  const snapshot = await postsCollection().where('userId', '==', ownerId).get();

  return snapshot.docs.map((doc) => {
    const data = doc.data() || {};
    const post = postFromDoc(doc);
    const lastResult = data.lastResult || null;

    return {
      ...post,
      title: data.title || data.postTitle || data.name || data.originalName || data.fileName || '',
      accountId: post.accountId,
      tiktokOpenId: post.tiktokOpenId,
      username: post.username,
      thumbnailUrl:
        data.thumbnailUrl ||
        data.thumbnail ||
        data.coverUrl ||
        data.imagePath ||
        data.publicImageUrl ||
        '',
      lastError:
        data.lastError ||
        data.errorMessage ||
        data.error ||
        (lastResult && (lastResult.reason || lastResult.error || lastResult.message)) ||
        '',
      logs: data.logs || data.events || data.history || []
    };
  }).sort(comparePosts);
}

async function getPost(userId, id, accountId) {
  if (!id) return null;
  const ownerId = userId || DEFAULT_USER_ID;
  const snap = await postsCollection().doc(id).get();
  if (!snap.exists) return null;
  if ((snap.data().userId || DEFAULT_USER_ID) !== ownerId) return null;
  const post = postFromDoc(snap);
  if (accountId && post.accountId !== accountId) return null;
  return post;
}

async function getRecentJobs(limit = 50) {
  const safeLimit = Math.min(100, Math.max(1, Number(limit) || 50));
  const snapshot = await postsCollection()
    .orderBy('updatedAt', 'desc')
    .limit(safeLimit)
    .get();
  return snapshot.docs.map(postFromDoc);
}

async function getMaxOrder(userId, accountId) {
  const posts = await getPosts(userId, accountId);
  return posts.reduce((max, post) => Math.max(max, Number(post.order || 0)), 0);
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

async function saveUploadToCloudinary(file) {
  return uploadMediaFile(file);
}

function cleanupLocalUpload(file) {
  if (!file || !file.path) return;
  try {
    const uploadPath = path.resolve(file.path);
    const uploadsRoot = path.resolve(config.uploadsDir);
    if (uploadPath.startsWith(uploadsRoot)) fs.unlinkSync(uploadPath);
  } catch (error) {
    // The durable copy already lives in Cloudinary; local cleanup is best effort.
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
  const accountId = String(defaults.accountId || defaults.tiktokOpenId || '').trim();
  const tiktokOpenId = String(defaults.tiktokOpenId || accountId).trim();
  const username = String(defaults.username || defaults.displayName || accountId).trim();
  if (!accountId || accountId === 'legacy') {
    const error = new Error('Select a connected TikTok account before creating scheduled posts');
    error.status = 400;
    throw error;
  }
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

  let order = (await getMaxOrder(ownerId, accountId)) + 1;
  const now = Timestamp.now();
  const db = getFirestore();
  const batch = db.batch();
  const created = [];
  const cloudinaryAssets = [];
  let committed = false;

  try {
    for (const file of sources) {
      const mediaType = file ? getUploadMediaType(file) : getPublicMediaType(fallbackUrl);
      const fileName = file ? getStoredFileName(file) : getPublicMediaName(fallbackUrl);
      const preparedMedia = file && defaults.preparedMedia
        && String(defaults.preparedMedia.originalName || '') === String(file.originalname || '')
        && Number(defaults.preparedMedia.originalSize || 0) === Number(file.size || 0)
        ? defaults.preparedMedia
        : null;
      let mediaUrl = fallbackUrl;
      let cloudinaryPublicId = '';
      let cloudinaryResourceType = '';
      let storageFallback = false;
      let autoMusicApplied = false;

      if (file) {
        try {
          let uploaded;
          if (preparedMedia) {
            try {
              uploaded = await saveUploadToCloudinary(preparedMedia.file);
              autoMusicApplied = true;
            } catch (error) {
              console.warn('[auto-music] prepared video upload failed; using original video', {
                code: error.code || 'CLOUDINARY_UPLOAD_FAILED'
              });
              uploaded = await saveUploadToCloudinary(file);
            }
          } else {
            uploaded = await saveUploadToCloudinary(file);
          }
          mediaUrl = uploaded.mediaUrl;
          cloudinaryPublicId = uploaded.publicId;
          cloudinaryResourceType = uploaded.resourceType;
          cloudinaryAssets.push({
            publicId: cloudinaryPublicId,
            resourceType: cloudinaryResourceType
          });
        } catch (error) {
          if (!fallbackUrl || uploadFiles.length !== 1) throw error;
          storageFallback = true;
          console.warn('[cloudinary] using submitted public media URL after upload failure', {
            code: error.code || 'CLOUDINARY_UPLOAD_FAILED'
          });
        }
      }

      const ref = postsCollection().doc(randomUUID());
      const publicMediaUrl = cloudinaryPublicId ? mediaUrl : fallbackUrl;

      const data = {
        userId: ownerId,
        platform: 'tiktok',
        accountId,
        tiktokOpenId,
        username,
        originalName: file ? file.originalname : fileName,
        fileName,
        mimeType: autoMusicApplied ? 'video/mp4' : ((file && file.mimetype) || getPublicMediaMimeType(mediaType, publicMediaUrl)),
        mediaType,
        mediaUrl,
        mediaPath: mediaUrl,
        mediaStoragePath: '',
        cloudinaryPublicId,
        cloudinaryResourceType,
        videoPath: mediaType === 'video' ? mediaUrl : '',
        imagePath: mediaType === 'photo' ? mediaUrl : '',
        publicMediaUrl,
        mediaSource: cloudinaryPublicId ? 'cloudinary' : 'public_url',
        storageFallback,
        autoMusicApplied,
        musicTrackId: autoMusicApplied ? String(preparedMedia.trackId || '') : '',
        musicCategory: autoMusicApplied ? String(preparedMedia.trackCategory || '') : '',
        musicMood: autoMusicApplied ? String(preparedMedia.trackMood || '') : '',
        caption: String(defaults.caption || '').trim(),
        hashtags: String(defaults.hashtags || '').trim(),
        publicImageUrl: mediaType === 'photo' ? publicMediaUrl : '',
        instagramMediaUrl: String(defaults.instagramMediaUrl || publicMediaUrl).trim(),
        privacyLevel:
          String(defaults.privacyLevel || config.tiktok.privacyLevel || 'SELF_ONLY').trim() || 'SELF_ONLY',
        scheduledAt: null,
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
    if (defaults.preparedMedia && defaults.preparedMedia.file) {
      cleanupLocalUpload(defaults.preparedMedia.file);
    }
    if (!committed) {
      await Promise.all(cloudinaryAssets.map((asset) =>
        destroyMediaAsset(asset.publicId, asset.resourceType)
      ));
    }
  }
}

async function updatePost(userId, id, patch, accountId) {
  const ownerId = userId || DEFAULT_USER_ID;
  const ref = postsCollection().doc(id);
  const snap = await ref.get();
  if (!snap.exists) return null;
  if ((snap.data().userId || DEFAULT_USER_ID) !== ownerId) return null;
  if (accountId && postFromDoc(snap).accountId !== accountId) return null;

  const firestorePatch = mapPatchToFirestore(patch);
  if ('scheduledAt' in firestorePatch && !['processing', 'posted'].includes(snap.data().status)) {
    firestorePatch.status = firestorePatch.scheduledAt ? 'scheduled' : 'pending';
  }
  await ref.update({ ...firestorePatch, updatedAt: FieldValue.serverTimestamp() });
  const updated = await ref.get();
  return postFromDoc(updated);
}

async function deletePost(userId, id, accountId) {
  const ownerId = userId || DEFAULT_USER_ID;
  const ref = postsCollection().doc(id);
  const snap = await ref.get();
  if (!snap.exists) return false;
  if ((snap.data().userId || DEFAULT_USER_ID) !== ownerId) return false;
  if (accountId && postFromDoc(snap).accountId !== accountId) return false;

  const data = snap.data();
  const fileName = data.fileName;
  const cloudinaryPublicId = data.cloudinaryPublicId;
  const cloudinaryResourceType = data.cloudinaryResourceType;
  await ref.delete();
  await destroyMediaAsset(cloudinaryPublicId, cloudinaryResourceType);

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

async function movePost(userId, id, direction, accountId) {
  const ownerId = userId || DEFAULT_USER_ID;
  const posts = await getPosts(ownerId, accountId);
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

async function autoSchedulePosts(userId, postIds, accountId) {
  const ownerId = userId || DEFAULT_USER_ID;
  const idSet = new Set(postIds);
  const posts = await getPosts(ownerId, accountId);
  const settings = await getSettings();
  let nextDate = getNextAvailableDate(posts, settings.dailyPostTime, idSet);

  const db = getFirestore();
  const batch = db.batch();
  let count = 0;

  for (const post of posts) {
    if (!idSet.has(post.id) || post.status !== 'pending') continue;
    batch.update(postsCollection().doc(post.id), {
      scheduledAt: Timestamp.fromDate(nextDate),
      status: 'scheduled',
      updatedAt: FieldValue.serverTimestamp()
    });
    nextDate = addDaysAtTime(nextDate, 1, settings.dailyPostTime);
    count += 1;
  }

  if (count > 0) await batch.commit();
  return count;
}

async function reschedulePendingQueue(userId, accountId) {
  const ownerId = userId || DEFAULT_USER_ID;
  const posts = await getPosts(ownerId, accountId);
  const settings = await getSettings();
  let nextDate = tomorrowAtTime(settings.dailyPostTime);

  const db = getFirestore();
  const batch = db.batch();
  let count = 0;

  for (const post of posts) {
    if (!['pending', 'scheduled'].includes(post.status)) continue;
    batch.update(postsCollection().doc(post.id), {
      scheduledAt: Timestamp.fromDate(nextDate),
      status: 'scheduled',
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
    .filter((post) => post.status === 'scheduled' && post.scheduledAt)
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

async function getCounts(userId, accountId) {
  const posts = await getPosts(userId, accountId);
  return posts.reduce(
    (counts, post) => {
      counts.total += 1;
      counts[post.status] = (counts[post.status] || 0) + 1;
      return counts;
    },
    { total: 0, pending: 0, scheduled: 0, processing: 0, ready: 0, posted: 0, failed: 0 }
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
  checkMediaStorageHealth,
  getPosts,
  getDashboardJobs,
  getPost,
  getRecentJobs,
  getSettings,
  saveSettings,
  getTikTokAccounts,
  getTikTokAccount,
  saveTikTokAccount,
  updateTikTokAccountProfile,
  disconnectTikTokAccount,
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
