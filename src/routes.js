const express = require('express');
const multer = require('multer');
const path = require('path');
const { randomUUID } = require('crypto');
const config = require('./config');
const storage = require('./storage');
const scheduler = require('./scheduler');
const tiktok = require('./tiktok');

const router = express.Router();

const upload = multer({
  storage: multer.diskStorage({
    destination: config.uploadsDir,
    filename: (req, file, callback) => {
      const extension = path.extname(file.originalname || '').toLowerCase() || '.jpg';
      callback(null, `${Date.now()}-${randomUUID()}${extension}`);
    }
  }),
  fileFilter: (req, file, callback) => {
    if (file.mimetype && file.mimetype.startsWith('image/')) {
      callback(null, true);
      return;
    }

    callback(new Error('Only image uploads are supported.'));
  },
  limits: {
    files: 100,
    fileSize: 25 * 1024 * 1024
  }
});

router.get('/', (req, res) => {
  const posts = storage.getPosts();
  const tiktokAuthStatus = tiktok.getTikTokAuthStatus();

  res.render('index', {
    appName: config.appName,
    posts,
    todayPost: getTodayPost(posts),
    settings: storage.getSettings(),
    counts: storage.getCounts(),
    notice: req.query.notice || '',
    tiktokConfigured: tiktokAuthStatus.connected,
    tiktokAuthStatus,
    helpers: viewHelpers
  });
});

router.get('/health', (req, res) => {
  res.json({
    ok: true,
    app: config.appName,
    uptimeSeconds: Math.round(process.uptime()),
    scheduler: 'running',
    tiktokConfigured: tiktok.isConfigured(),
    tiktokAuth: tiktok.getTikTokAuthStatus(),
    counts: storage.getCounts()
  });
});

router.get('/connect/tiktok', (req, res) => {
  if (!config.tiktok.clientKey || !config.tiktok.clientSecret || !config.tiktok.redirectUri) {
    redirectWithNotice(res, 'Add TikTok client key, secret, and redirect URI to .env first.');
    return;
  }

  const state = randomUUID();
  res.cookie('tiktok_oauth_state', state, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 10 * 60 * 1000
  });
  res.redirect(tiktok.buildTikTokAuthUrl(state));
});

router.get('/auth/tiktok/callback', async (req, res) => {
  const expectedState = parseCookies(req.headers.cookie).tiktok_oauth_state;
  res.clearCookie('tiktok_oauth_state');

  if (req.query.error) {
    redirectWithNotice(res, `TikTok connection failed: ${req.query.error_description || req.query.error}`);
    return;
  }

  if (!req.query.code || !req.query.state || req.query.state !== expectedState) {
    redirectWithNotice(res, 'TikTok connection failed: invalid OAuth state.');
    return;
  }

  try {
    const auth = await tiktok.exchangeCodeForToken(String(req.query.code));
    storage.saveTikTokAuth(auth);
    redirectWithNotice(res, 'TikTok connected.');
  } catch (error) {
    redirectWithNotice(res, `TikTok connection failed: ${error.message}`);
  }
});

router.get('/disconnect/tiktok', (req, res) => {
  storage.clearTikTokAuth();
  redirectWithNotice(res, 'TikTok disconnected. Manual Mode restored.');
});

router.post('/upload', upload.array('images'), (req, res) => {
  const files = req.files || [];
  if (files.length === 0) {
    redirectWithNotice(res, 'Choose at least one image to upload.');
    return;
  }

  const created = storage.addUploadedPosts(files, {
    caption: req.body.caption,
    hashtags: req.body.hashtags
  });
  const scheduledCount = storage.autoSchedulePosts(created.map((post) => post.id));

  redirectWithNotice(res, `Uploaded ${created.length}. Scheduled ${scheduledCount}.`);
});

router.post('/settings', (req, res) => {
  const dailyPostTime = String(req.body.dailyPostTime || '').trim();
  if (!/^\d{2}:\d{2}$/.test(dailyPostTime)) {
    redirectWithNotice(res, 'Use a valid daily posting time.');
    return;
  }

  storage.saveSettings({ dailyPostTime });
  redirectWithNotice(res, `Schedule set to ${dailyPostTime}.`);
});

router.post('/schedule', (req, res) => {
  const count = storage.reschedulePendingQueue();
  redirectWithNotice(res, `Scheduled ${count}.`);
});

router.post('/posts/:id', (req, res) => {
  const scheduledAt = parseDateTimeLocal(req.body.scheduledAt);
  storage.updatePost(req.params.id, {
    caption: String(req.body.caption || '').trim(),
    hashtags: String(req.body.hashtags || '').trim(),
    publicImageUrl: String(req.body.publicImageUrl || '').trim(),
    scheduledAt
  });

  redirectWithNotice(res, 'Saved.');
});

router.post('/posts/:id/move', (req, res) => {
  const moved = storage.movePost(req.params.id, req.body.direction);
  redirectWithNotice(res, moved ? 'Moved.' : 'Could not move item.');
});

router.post('/posts/:id/prepare', async (req, res) => {
  const result = await scheduler.processPost(req.params.id);
  if (result.ok) {
    redirectWithNotice(res, 'Sent to TikTok.');
    return;
  }

  if (result.mode === 'manual') {
    redirectWithNotice(res, 'Ready to post.');
    return;
  }

  redirectWithNotice(res, `TikTok attempt failed: ${result.reason || 'Unknown error'}`);
});

router.post('/posts/:id/posted', (req, res) => {
  storage.updatePost(req.params.id, {
    status: 'posted',
    postedAt: new Date().toISOString()
  });
  redirectWithNotice(res, 'Marked posted.');
});

router.post('/posts/:id/pending', (req, res) => {
  storage.updatePost(req.params.id, {
    status: 'pending',
    postedAt: null,
    readyAt: null
  });
  redirectWithNotice(res, 'Back to pending.');
});

router.post('/posts/:id/delete', (req, res) => {
  storage.deletePost(req.params.id);
  redirectWithNotice(res, 'Deleted.');
});

function redirectWithNotice(res, notice) {
  res.redirect(`/?notice=${encodeURIComponent(notice)}`);
}

function parseCookies(header) {
  return String(header || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const separatorIndex = part.indexOf('=');
      if (separatorIndex === -1) return cookies;

      const name = decodeURIComponent(part.slice(0, separatorIndex));
      const value = decodeURIComponent(part.slice(separatorIndex + 1));
      cookies[name] = value;
      return cookies;
    }, {});
}

function parseDateTimeLocal(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function getTodayPost(posts) {
  const today = new Date();
  const start = new Date(today);
  start.setHours(0, 0, 0, 0);

  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  const scheduledToday = (post) => {
    if (!post.scheduledAt) return false;
    const scheduled = new Date(post.scheduledAt);
    return scheduled >= start && scheduled < end;
  };

  return (
    posts.find((post) => post.status === 'ready') ||
    posts.find((post) => scheduledToday(post) && post.status !== 'posted') ||
    posts.find((post) => scheduledToday(post)) ||
    null
  );
}

const viewHelpers = {
  formatDateTime(value) {
    if (!value) return 'Not scheduled';
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short'
    }).format(new Date(value));
  },
  formatTime(value) {
    if (!value) return 'No time';
    return new Intl.DateTimeFormat(undefined, {
      hour: 'numeric',
      minute: '2-digit'
    }).format(new Date(value));
  },
  dateTimeInput(value) {
    if (!value) return '';
    const date = new Date(value);
    const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return localDate.toISOString().slice(0, 16);
  },
  fullCaption(post) {
    return tiktok.buildCaption(post);
  },
  statusLabel(status) {
    const value = String(status || 'pending');
    return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
  }
};

module.exports = router;
