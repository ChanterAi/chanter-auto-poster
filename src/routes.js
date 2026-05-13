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
      const extension = path.extname(file.originalname || '').toLowerCase() || defaultExtension(file);
      callback(null, `${Date.now()}-${randomUUID()}${extension}`);
    }
  }),
  fileFilter: (req, file, callback) => {
    const mime = String(file.mimetype || '').toLowerCase();

    if (mime.startsWith('image/') || mime.startsWith('video/')) {
      callback(null, true);
      return;
    }

    callback(new Error('Only image and video uploads are supported.'));
  },
  limits: {
    files: 100,
    fileSize: 250 * 1024 * 1024
  }
});

function defaultExtension(file) {
  const mime = String(file.mimetype || '').toLowerCase();
  if (mime === 'video/mp4') return '.mp4';
  if (mime === 'video/quicktime') return '.mov';
  if (mime === 'video/webm') return '.webm';
  if (mime === 'image/png') return '.png';
  if (mime === 'image/webp') return '.webp';
  return '.jpg';
}

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
    redirectWithNotice(res, 'Choose at least one image or video to upload.');
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
  const post = storage.getPost(req.params.id);

  if (!post) {
    redirectWithNotice(res, 'Post not found.');
    return;
  }

  const forcePostNow = String(req.body.force || '') === '1';
  const scheduledAt = post.scheduledAt ? new Date(post.scheduledAt) : null;

  if (!forcePostNow && scheduledAt && scheduledAt.getTime() > Date.now()) {
    redirectWithNotice(
      res,
      `Saved. This post is scheduled for later: ${viewHelpers.formatDateTime(post.scheduledAt)}. It will publish automatically at that time.`
    );
    return;
  }

  const result = await scheduler.processPost(req.params.id);

  if (result.ok) {
    redirectWithNotice(res, 'TikTok accepted the publish request. Review Post Result for details.');
    return;
  }

  if (result.mode === 'manual') {
    redirectWithNotice(res, 'Needs manual verification. Review Post Result for details.');
    return;
  }

  redirectWithNotice(res, `TikTok attempt failed: ${result.reason || 'Unknown error'}`);
});

router.post('/posts/:id/posted', (req, res) => {
  const now = new Date().toISOString();
  storage.updatePost(req.params.id, {
    status: 'posted',
    postedAt: now,
    readyAt: null,
    lastResult: {
      ok: true,
      mode: 'manual',
      reason: 'Marked posted manually',
      completedAt: now
    }
  });
  redirectWithNotice(res, 'Marked posted.');
});

router.post('/posts/:id/pending', (req, res) => {
  storage.updatePost(req.params.id, {
    status: 'pending',
    postedAt: null,
    readyAt: null,
    lastResult: null
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
  mediaType(post) {
    return getPostMediaType(post);
  },
  mediaPath(post) {
    return getPostMediaPath(post);
  },
  mediaLabel(post) {
    return getPostMediaType(post) === 'video' ? 'Video' : 'Image';
  },
  mediaOpenLabel(post) {
    return getPostMediaType(post) === 'video' ? 'Open video' : 'Open image';
  },
  mediaWorkflowLabel(post) {
    return getPostMediaType(post) === 'video' ? 'Video + original audio' : 'Photo source';
  },
  publicUrlNote(post) {
    return getPostMediaType(post) === 'video'
      ? 'Not needed for video uploads.'
      : 'HTTPS source for photo API publishing.';
  },
  hasLocalMedia(post) {
    return Boolean(getPostMediaPath(post));
  },
  hasPublishablePhotoSource(post) {
    if (getPostMediaType(post) !== 'photo') return true;
    return Boolean(tiktok.getPublicImageUrl(post));
  },
  postResult(post) {
    return buildPostResultView(post);
  },
  resultDebugJson(post) {
    return getDebugJson(post);
  },
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
    return statusLabel(status);
  }
};

function getPostMediaType(post) {
  const mediaType = String((post && post.mediaType) || '').toLowerCase();
  if (mediaType === 'video') return 'video';

  const fileName = String((post && (post.fileName || post.mediaPath || post.videoPath)) || '').toLowerCase();
  if (['.mp4', '.mov', '.webm'].some((extension) => fileName.endsWith(extension))) {
    return 'video';
  }

  return 'photo';
}

function getPostMediaPath(post) {
  if (!post) return '';
  if (getPostMediaType(post) === 'video') {
    return post.videoPath || post.mediaPath || post.imagePath || '';
  }

  return post.imagePath || post.mediaPath || '';
}

function buildPostResultView(post) {
  const lastResult = post && post.lastResult ? post.lastResult : null;
  const responseSource = lastResult ? lastResult.response || lastResult : null;
  const metadata = getPublishMetadata(responseSource);
  const shareUrl = getFirstValue(responseSource, [
    'share_url',
    'shareUrl',
    'post_url',
    'postUrl',
    'permalink',
    'public_url',
    'publicUrl'
  ]);
  const publishId = getFirstValue(responseSource, ['publish_id', 'publishId']);
  const status = String((post && post.status) || 'pending').toLowerCase();
  const isApiAccepted = Boolean(lastResult && lastResult.ok && lastResult.mode === 'api');
  const debugJson = getDebugJson(post);

  let stateLabel = 'Scheduled';
  let tone = 'scheduled';
  let message = post && post.scheduledAt
    ? `Scheduled for ${viewHelpers.formatDateTime(post.scheduledAt)}.`
    : 'Waiting for a schedule time.';

  if (status === 'publishing') {
    stateLabel = 'Publishing';
    tone = 'publishing';
    message = 'Publishing to TikTok. Large videos can take a moment.';
  } else if (status === 'failed' || (lastResult && lastResult.ok === false && lastResult.mode !== 'manual')) {
    stateLabel = 'Failed';
    tone = 'failed';
    message = (lastResult && lastResult.reason) || 'TikTok rejected the publish request.';
  } else if (status === 'ready' || (lastResult && lastResult.mode === 'manual' && status !== 'posted')) {
    stateLabel = 'Needs manual verification';
    tone = 'verification';
    message = (lastResult && lastResult.reason) || 'Open the media and verify or post inside TikTok.';
  } else if (status === 'posted' && isApiAccepted) {
    stateLabel = 'Posted / API accepted';
    tone = shareUrl ? 'accepted' : 'verification';
    message = shareUrl
      ? 'TikTok returned a public post URL.'
      : 'TikTok accepted the publish request, but no public post URL was returned. Please verify inside TikTok.';
  } else if (status === 'posted') {
    stateLabel = 'Posted manually';
    tone = 'accepted';
    message = (lastResult && lastResult.reason) || 'This item was marked posted manually.';
  }

  return {
    stateLabel,
    tone,
    message,
    metadata,
    shareUrl,
    publishId,
    debugJson,
    hasDebug: Boolean(debugJson),
    hasAttempt: Boolean(lastResult),
    statusCheckAvailable: false
  };
}

function getPublishMetadata(source) {
  if (!source) return [];

  const rows = [
    ['Publish ID', getFirstValue(source, ['publish_id', 'publishId'])],
    ['Post ID', getFirstValue(source, ['post_id', 'postId', 'item_id', 'itemId', 'video_id', 'videoId'])],
    ['Share URL', getFirstValue(source, ['share_url', 'shareUrl', 'post_url', 'postUrl', 'permalink', 'public_url', 'publicUrl'])],
    ['Status', getFirstValue(source, ['status', 'publish_status', 'publishStatus'])],
    ['Log ID', getFirstValue(source, ['log_id', 'logId'])]
  ];

  return rows
    .filter((row) => row[1] !== undefined && row[1] !== null && String(row[1]).trim() !== '')
    .map(([label, value]) => ({
      label,
      value: formatMetadataValue(value),
      isUrl: isHttpUrl(value)
    }));
}

function getFirstValue(source, keys) {
  const found = findValuesByKeys(source, new Set(keys.map((key) => key.toLowerCase())));
  return found.length > 0 ? found[0] : '';
}

function findValuesByKeys(value, keySet, found = []) {
  if (!value || typeof value !== 'object') return found;

  if (Array.isArray(value)) {
    value.forEach((item) => findValuesByKeys(item, keySet, found));
    return found;
  }

  Object.entries(value).forEach(([key, nestedValue]) => {
    if (keySet.has(key.toLowerCase())) {
      found.push(nestedValue);
    }

    if (nestedValue && typeof nestedValue === 'object') {
      findValuesByKeys(nestedValue, keySet, found);
    }
  });

  return found;
}

function formatMetadataValue(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function isHttpUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (error) {
    return false;
  }
}

function getDebugJson(post) {
  if (!post || !post.lastResult) return '';
  return JSON.stringify(post.lastResult, null, 2);
}

function statusLabel(status) {
  const labels = {
    pending: 'Scheduled',
    publishing: 'Publishing',
    ready: 'Needs manual verification',
    posted: 'Posted',
    failed: 'Failed'
  };
  const value = String(status || 'pending').toLowerCase();
  return labels[value] || `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

module.exports = router;
