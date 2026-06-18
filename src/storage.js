const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const config = require('./config');
const { postsCollection, configDoc, getFirestore, Timestamp, FieldValue } = require('./firestore');
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
    .orderBy('order', 'desc')
    .limit(1)
    .get();
  if (snapshot.empty) return 0;
  return Number(snapshot.docs[0].data().order || 0);
}

function getUploadMediaType(file) {
  const mime = String(file.mimetype || '').toLowerCase();
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('image/')) return 'photo';

  const extension = path.extname(file.originalname || file.filename || '').toLowerCase();
  if (['.mp4', '.mov', '.webm'].includes(extension)) return 'video';
  return 'photo';
}

async function addUploadedPosts(userId, files, defaults = {}) {
  const ownerId = userId || DEFAULT_USER_ID;
  let order = (await getMaxOrder(ownerId)) + 1;
  const now = Timestamp.now();
  const db = getFirestore();
  const batch = db.batch();
  const created = [];

  files.forEach((file) => {
    const mediaType = getUploadMediaType(file);
    const mediaPath = `/uploads/${file.filename}`;
    const ref = postsCollection().doc(randomUUID());

    const data = {
      userId: ownerId,
      platform: 'tiktok',
      originalName: file.originalname,
      fileName: file.filename,
      mimeType: file.mimetype || '',
      mediaType,
      mediaPath,
      videoPath: mediaType === 'video' ? mediaPath : '',
      imagePath: mediaType === 'photo' ? mediaPath : '',
      caption: String(defaults.caption || '').trim(),
      hashtags: String(defaults.hashtags || '').trim(),
      publicImageUrl: String(defaults.publicImageUrl || '').trim(),
      instagramMediaUrl: String(defaults.instagramMediaUrl || '').trim(),
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
  });

  await batch.commit();
  return created.map(({ ref, data }) => postFromDoc({ id: ref.id, data: () => data }));
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

  const fileName = snap.data().fileName;
  await ref.delete();

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
  const date = new Date();
  date.setDate(date.getDate() + 1);
  return setTime(date, time);
}

function addDaysAtTime(date, days, time) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return setTime(next, time);
}

function setTime(date, time) {
  const [hours, minutes] = String(time || '09:00')
    .split(':')
    .map((part) => Number(part));

  const next = new Date(date);
  next.setHours(Number.isFinite(hours) ? hours : 9, Number.isFinite(minutes) ? minutes : 0, 0, 0);
  return next;
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
