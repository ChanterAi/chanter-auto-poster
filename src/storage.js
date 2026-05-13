const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const config = require('./config');

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

function ensureStorage() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.uploadsDir, { recursive: true });

  if (!fs.existsSync(config.postsFile)) {
    writeJson(config.postsFile, []);
  }

  if (!fs.existsSync(config.settingsFile)) {
    writeJson(config.settingsFile, defaultSettings);
  }

  if (!fs.existsSync(config.tiktokAuthFile)) {
    writeJson(config.tiktokAuthFile, defaultTikTokAuth);
  }
}

function readJson(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return raw.trim() ? JSON.parse(raw) : fallback;
  } catch (error) {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function getPosts() {
  ensureStorage();
  const posts = readJson(config.postsFile, []);
  return sortPosts(Array.isArray(posts) ? posts : []);
}

function savePosts(posts) {
  writeJson(config.postsFile, sortPosts(posts));
}

function getPost(id) {
  return getPosts().find((post) => post.id === id) || null;
}

function getSettings() {
  ensureStorage();
  return {
    ...defaultSettings,
    ...readJson(config.settingsFile, defaultSettings)
  };
}

function saveSettings(settings) {
  const nextSettings = {
    ...getSettings(),
    ...settings,
    updatedAt: new Date().toISOString()
  };
  writeJson(config.settingsFile, nextSettings);
  return nextSettings;
}

function getTikTokAuth() {
  ensureStorage();
  return {
    ...defaultTikTokAuth,
    ...readJson(config.tiktokAuthFile, defaultTikTokAuth)
  };
}

function saveTikTokAuth(auth) {
  const nextAuth = {
    ...defaultTikTokAuth,
    ...auth,
    connected: Boolean(auth.connected && auth.access_token)
  };

  writeJson(config.tiktokAuthFile, nextAuth);
  return nextAuth;
}

function clearTikTokAuth() {
  writeJson(config.tiktokAuthFile, defaultTikTokAuth);
  return defaultTikTokAuth;
}

function sortPosts(posts) {
  return [...posts].sort((a, b) => {
    const orderDiff = Number(a.order || 0) - Number(b.order || 0);
    if (orderDiff !== 0) return orderDiff;
    return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
  });
}

function nextOrder(posts) {
  return posts.reduce((max, post) => Math.max(max, Number(post.order || 0)), 0) + 1;
}

function getUploadMediaType(file) {
  const mime = String(file.mimetype || '').toLowerCase();
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('image/')) return 'photo';

  const extension = path.extname(file.originalname || file.filename || '').toLowerCase();
  if (['.mp4', '.mov', '.webm'].includes(extension)) return 'video';
  return 'photo';
}

function addUploadedPosts(files, defaults = {}) {
  const posts = getPosts();
  const now = new Date().toISOString();
  let order = nextOrder(posts);

  const created = files.map((file) => {
    const mediaType = getUploadMediaType(file);
    const mediaPath = `/uploads/${file.filename}`;

    return {
      id: randomUUID(),
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
      scheduledAt: null,
      status: 'pending',
      order: order++,
      createdAt: now,
      updatedAt: now,
      postedAt: null,
      readyAt: null,
      lastResult: null
    };
  });

  savePosts([...posts, ...created]);
  return created;
}

function updatePost(id, patch) {
  const posts = getPosts();
  const index = posts.findIndex((post) => post.id === id);
  if (index === -1) return null;

  posts[index] = {
    ...posts[index],
    ...patch,
    updatedAt: new Date().toISOString()
  };

  savePosts(posts);
  return posts[index];
}

function deletePost(id) {
  const posts = getPosts();
  const post = posts.find((item) => item.id === id);
  if (!post) return false;

  const nextPosts = posts.filter((item) => item.id !== id);
  savePosts(nextPosts);

  if (post.fileName) {
    const uploadPath = path.resolve(config.uploadsDir, post.fileName);
    if (uploadPath.startsWith(path.resolve(config.uploadsDir))) {
      try {
        fs.unlinkSync(uploadPath);
      } catch (error) {
        // The queue item can still be removed even if the local media is gone.
      }
    }
  }

  return true;
}

function movePost(id, direction) {
  const posts = getPosts();
  const index = posts.findIndex((post) => post.id === id);
  const targetIndex = direction === 'up' ? index - 1 : index + 1;

  if (index < 0 || targetIndex < 0 || targetIndex >= posts.length) {
    return false;
  }

  const currentOrder = posts[index].order;
  posts[index].order = posts[targetIndex].order;
  posts[targetIndex].order = currentOrder;
  posts[index].updatedAt = new Date().toISOString();
  posts[targetIndex].updatedAt = new Date().toISOString();
  savePosts(posts);
  return true;
}

function getDuePendingPosts(now = new Date()) {
  const nowTime = now.getTime();
  return getPosts()
    .filter((post) => {
      if (post.status !== 'pending' || !post.scheduledAt) return false;
      return new Date(post.scheduledAt).getTime() <= nowTime;
    })
    .sort((a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime());
}

function autoSchedulePosts(postIds) {
  const idSet = new Set(postIds);
  const posts = getPosts();
  const settings = getSettings();
  let nextDate = getNextAvailableDate(posts, settings.dailyPostTime, idSet);
  let count = 0;

  for (const post of posts) {
    if (!idSet.has(post.id) || post.status !== 'pending') continue;
    post.scheduledAt = nextDate.toISOString();
    post.updatedAt = new Date().toISOString();
    nextDate = addDaysAtTime(nextDate, 1, settings.dailyPostTime);
    count += 1;
  }

  savePosts(posts);
  return count;
}

function reschedulePendingQueue() {
  const posts = getPosts();
  const settings = getSettings();
  let nextDate = tomorrowAtTime(settings.dailyPostTime);
  let count = 0;

  for (const post of posts) {
    if (post.status !== 'pending') continue;
    post.scheduledAt = nextDate.toISOString();
    post.updatedAt = new Date().toISOString();
    nextDate = addDaysAtTime(nextDate, 1, settings.dailyPostTime);
    count += 1;
  }

  savePosts(posts);
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

function getCounts() {
  return getPosts().reduce(
    (counts, post) => {
      counts.total += 1;
      counts[post.status] = (counts[post.status] || 0) + 1;
      return counts;
    },
    { total: 0, pending: 0, ready: 0, posted: 0, failed: 0 }
  );
}

module.exports = {
  ensureStorage,
  getPosts,
  getPost,
  savePosts,
  getSettings,
  saveSettings,
  getTikTokAuth,
  saveTikTokAuth,
  clearTikTokAuth,
  addUploadedPosts,
  updatePost,
  deletePost,
  movePost,
  getDuePendingPosts,
  autoSchedulePosts,
  reschedulePendingQueue,
  getCounts
};
