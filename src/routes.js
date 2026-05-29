const express = require('express');
const multer = require('multer');
const path = require('path');
const { randomUUID } = require('crypto');
const config = require('./config');
const storage = require('./storage');
const scheduler = require('./scheduler');
const tiktok = require('./tiktok');
const instagram = require('./instagram');

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
    if (mime.startsWith('image/') || mime.startsWith('video/')) { callback(null, true); return; }
    callback(new Error('Only image and video uploads are supported.'));
  },
  limits: { files: 100, fileSize: 250 * 1024 * 1024 }
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

router.get('/', async (req, res) => {
  const posts = storage.getPosts();
  const tiktokAuthStatus = tiktok.getTikTokAuthStatus();
  const instagramStatus = instagram.getInstagramAuthStatus();
  const creatorInfo = tiktokAuthStatus.connected ? await getCreatorInfoSafe() : null;

  res.render('index', {
    appName: config.appName,
    posts,
    todayPost: getTodayPost(posts),
    settings: storage.getSettings(),
    counts: storage.getCounts(),
    notice: req.query.notice || '',
    tiktokConfigured: tiktokAuthStatus.connected,
    tiktokAuthStatus,
    instagramStatus,
    creatorInfo,
    helpers: viewHelpers
  });
});

router.get('/health', (req, res) => {
  res.json({
    ok: true,
    app: config.appName,
    uptimeSeconds: Math.round(process.uptime()),
    scheduler: 'running',
    cronTrigger: true,
    tiktokConfigured: tiktok.isConfigured(),
    tiktokAuth: tiktok.getTikTokAuthStatus(),
    instagram: instagram.getInstagramAuthStatus(),
    counts: storage.getCounts()
  });
});

router.get('/run-scheduler', async (req, res) => {
  if (config.cronSecret && req.query.secret !== config.cronSecret) {
    res.status(403).json({ ok: false, triggered: false, reason: 'Invalid cron secret' });
    return;
  }
  const result = await scheduler.publishNextPost();
  res.json({ ok: true, triggered: true, result });
});

router.get('/connect/tiktok', (req, res) => {
  if (!config.tiktok.clientKey || !config.tiktok.clientSecret || !config.tiktok.redirectUri) {
    redirectWithNotice(res, 'Add TikTok client key, secret, and redirect URI to .env first.');
    return;
  }
  const state = randomUUID();
  res.cookie('tiktok_oauth_state', state, { httpOnly: true, sameSite: 'lax', maxAge: 10 * 60 * 1000 });
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

router.get('/auth/instagram/start', (req, res) => {
  if (!instagram.hasOAuthConfig()) {
    redirectWithNotice(res, 'Add Meta app ID, app secret, and redirect URI to .env first.');
    return;
  }
  const state = randomUUID();
  res.cookie('instagram_oauth_state', state, { httpOnly: true, sameSite: 'lax', maxAge: 10 * 60 * 1000 });
  res.redirect(instagram.buildInstagramAuthUrl(state));
});

router.get('/auth/instagram/callback', async (req, res) => {
  const expectedState = parseCookies(req.headers.cookie).instagram_oauth_state;
  res.clearCookie('instagram_oauth_state');
  if (req.query.error) {
    redirectWithNotice(res, `Instagram connection failed: ${req.query.error_description || req.query.error}`);
    return;
  }
  if (!req.query.code || !req.query.state || req.query.state !== expectedState) {
    redirectWithNotice(res, 'Instagram connection failed: invalid OAuth state.');
    return;
  }
  try {
    const auth = await instagram.exchangeCodeForToken(String(req.query.code));
    storage.saveInstagramAuth(auth);
    redirectWithNotice(res, 'Instagram connected.');
  } catch (error) {
    redirectWithNotice(res, `Instagram connection failed: ${error.message}`);
  }
});

router.get('/disconnect/instagram', (req, res) => {
  storage.clearInstagramAuth();
  redirectWithNotice(res, 'Instagram disconnected.');
});

router.get('/api/instagram/status', async (req, res) => {
  const status = instagram.getInstagramAuthStatus();
  const containerId = String(req.query.containerId || '').trim();
  if (!containerId) { res.json({ ok: true, instagram: status }); return; }
  try {
    const container = await instagram.getContainerStatus(containerId);
    res.json({ ok: true, instagram: status, container });
  } catch (error) {
    res.status(400).json({ ok: false, instagram: status, reason: error.message, response: error.response || null });
  }
});

router.post('/api/instagram/publish', express.json({ limit: '1mb' }), async (req, res) => {
  const payload = { ...(req.body || {}), postId: String((req.body && req.body.postId) || '').trim() };
  try {
    const result = await instagram.publishInstagramMedia(payload);
    saveInstagramAttempt(payload.postId, result);
    if (wantsJson(req)) { res.status(result.ok ? 200 : 400).json({ ok: result.ok, result }); return; }
    redirectWithNotice(res, instagramNotice(result));
  } catch (error) {
    const result = { ok: false, mode: 'api', published: false, reason: error.message, response: error.response || null };
    saveInstagramAttempt(payload.postId, result);
    if (wantsJson(req)) { res.status(400).json({ ok: false, result }); return; }
    redirectWithNotice(res, `Instagram attempt failed: ${error.message}`);
  }
});

router.post('/upload', upload.array('images'), (req, res) => {
  const files = req.files || [];
  if (files.length === 0) { redirectWithNotice(res, 'Choose at least one image or video to upload.'); return; }
  const created = storage.addUploadedPosts(files, { caption: req.body.caption, hashtags: req.body.hashtags });
  const scheduledCount = storage.autoSchedulePosts(created.map(p => p.id));
  redirectWithNotice(res, `Uploaded ${created.length}. Scheduled ${scheduledCount}.`);
});

router.post('/settings', (req, res) => {
  const dailyPostTime = String(req.body.dailyPostTime || '').trim();
  if (!/^\d{2}:\d{2}$/.test(dailyPostTime)) { redirectWithNotice(res, 'Use a valid daily posting time.'); return; }
  storage.saveSettings({ dailyPostTime });
  redirectWithNotice(res, `Schedule set to ${dailyPostTime}.`);
});

router.post('/schedule', (req, res) => {
  const count = storage.reschedulePendingQueue();
  redirectWithNotice(res, `Scheduled ${count}.`);
});

// ── Updated post save — now captures interaction settings & content disclosure ──
router.post('/posts/:id', (req, res) => {
  const scheduledAt = parseDateTimeLocal(req.body.scheduledAt, req.body.timezoneOffsetMinutes);

  // Interaction ability: checkbox presence means enabled
  const allowComment    = req.body.allowComment    === '1';
  const allowDuet       = req.body.allowDuet       === '1';
  const allowStitch     = req.body.allowStitch      === '1';

  // Content disclosure
  const contentDisclosure = req.body.contentDisclosure === '1';
  const yourBrand         = contentDisclosure && req.body.yourBrand      === '1';
  const brandedContent    = contentDisclosure && req.body.brandedContent === '1';

  storage.updatePost(req.params.id, {
    caption:            String(req.body.caption            || '').trim(),
    hashtags:           String(req.body.hashtags           || '').trim(),
    publicImageUrl:     String(req.body.publicImageUrl     || '').trim(),
    instagramMediaUrl:  String(req.body.instagramMediaUrl  || '').trim(),
    privacyLevel:       String(req.body.privacyLevel       || config.tiktok.privacyLevel || 'SELF_ONLY').trim() || 'SELF_ONLY',
    scheduledAt,
    // TikTok Direct Post API — interaction ability
    disableComment:  !allowComment,
    disableDuet:     !allowDuet,
    disableStitch:   !allowStitch,
    // Content disclosure
    contentDisclosure,
    yourBrand,
    brandedContent
  });

  redirectWithNotice(res, 'Saved.');
});

router.post('/posts/:id/move', (req, res) => {
  const moved = storage.movePost(req.params.id, req.body.direction);
  redirectWithNotice(res, moved ? 'Moved.' : 'Could not move item.');
});

router.post('/posts/:id/prepare', async (req, res) => {
  const post = storage.getPost(req.params.id);
  if (!post) { redirectWithNotice(res, 'Post not found.'); return; }

  const forcePostNow = String(req.body.force || '') === '1';
  const scheduledAt = post.scheduledAt ? new Date(post.scheduledAt) : null;

  if (!forcePostNow && scheduledAt && scheduledAt.getTime() > Date.now()) {
    redirectWithNotice(res, `Scheduled for ${viewHelpers.formatDateTime(post.scheduledAt)}. It will publish automatically.`);
    return;
  }

  const result = await scheduler.processPost(req.params.id);
  if (result.ok) { redirectWithNotice(res, 'TikTok accepted the publish request. Review Post Result for details.'); return; }
  if (result.mode === 'manual') { redirectWithNotice(res, 'Needs manual verification. Review Post Result for details.'); return; }
  redirectWithNotice(res, `TikTok attempt failed: ${result.reason || 'Unknown error'}`);
});

router.post('/posts/:id/posted', (req, res) => {
  const now = new Date().toISOString();
  storage.updatePost(req.params.id, {
    status: 'posted', postedAt: now, readyAt: null,
    lastResult: { ok: true, mode: 'manual', reason: 'Marked posted manually', completedAt: now }
  });
  redirectWithNotice(res, 'Marked posted.');
});

router.post('/posts/:id/pending', (req, res) => {
  storage.updatePost(req.params.id, { status: 'pending', postedAt: null, readyAt: null, lastResult: null });
  redirectWithNotice(res, 'Back to pending.');
});

router.post('/posts/:id/delete', (req, res) => {
  storage.deletePost(req.params.id);
  redirectWithNotice(res, 'Deleted.');
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function redirectWithNotice(res, notice) {
  res.redirect(`/?notice=${encodeURIComponent(notice)}`);
}

async function getCreatorInfoSafe() {
  try { return await tiktok.queryCreatorInfo(); }
  catch (error) { console.warn('[routes] TikTok creator info unavailable', error.message); return null; }
}

function parseCookies(header) {
  return String(header || '').split(';').map(p => p.trim()).filter(Boolean)
    .reduce((cookies, part) => {
      const sep = part.indexOf('=');
      if (sep === -1) return cookies;
      cookies[decodeURIComponent(part.slice(0, sep))] = decodeURIComponent(part.slice(sep + 1));
      return cookies;
    }, {});
}

function parseDateTimeLocal(value, timezoneOffsetMinutes) {
  if (!value) return null;
  const fallback = () => { const d = new Date(value); return isNaN(d.getTime()) ? null : d.toISOString(); };
  if (timezoneOffsetMinutes === undefined || timezoneOffsetMinutes === null || timezoneOffsetMinutes === '') return fallback();
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!match) return fallback();
  const [, year, month, day, hour, minute] = match;
  const offset = Number(timezoneOffsetMinutes);
  if (!Number.isFinite(offset)) return fallback();
  const utc = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute)) + offset * 60000;
  return Number.isFinite(utc) ? new Date(utc).toISOString() : null;
}

function getTodayPost(posts) {
  const today = new Date();
  const start = new Date(today); start.setHours(0, 0, 0, 0);
  const end = new Date(start); end.setDate(end.getDate() + 1);
  const scheduledToday = p => {
    if (!p.scheduledAt) return false;
    const s = new Date(p.scheduledAt);
    return s >= start && s < end;
  };
  return posts.find(p => p.status === 'ready')
    || posts.find(p => scheduledToday(p) && p.status !== 'posted')
    || posts.find(p => scheduledToday(p))
    || null;
}

// ── View helpers ──────────────────────────────────────────────────────────────

const viewHelpers = {
  mediaType(post) { return getPostMediaType(post); },
  mediaPath(post) { return getPostMediaPath(post); },
  mediaLabel(post) { return getPostMediaType(post) === 'video' ? 'Video' : 'Image'; },
  mediaOpenLabel(post) { return getPostMediaType(post) === 'video' ? 'Open video' : 'Open image'; },
  mediaWorkflowLabel(post) { return getPostMediaType(post) === 'video' ? 'Video + original audio' : 'Photo source'; },
  publicUrlNote(post) { return getPostMediaType(post) === 'video' ? 'Not needed for video uploads.' : 'HTTPS source for photo API publishing.'; },
  hasLocalMedia(post) { return Boolean(getPostMediaPath(post)); },
  hasPublishablePhotoSource(post) {
    if (getPostMediaType(post) !== 'photo') return true;
    return Boolean(tiktok.getPublicImageUrl(post));
  },
  postResult(post) { return buildPostResultView(post); },
  resultDebugJson(post) { return getDebugJson(post); },
  instagramPostResult(post) { return buildInstagramPostResultView(post); },
  instagramResultDebugJson(post) { return getInstagramDebugJson(post); },
  formatDateTime(value) {
    if (!value) return 'Not scheduled';
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
  },
  formatTime(value) {
    if (!value) return 'No time';
    return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(value));
  },
  dateTimeInput(value) {
    if (!value) return '';
    const date = new Date(value);
    const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16);
  },
  fullCaption(post) { return tiktok.buildCaption(post); },
  statusLabel(status) { return statusLabel(status); }
};

function getPostMediaType(post) {
  const mediaType = String((post && post.mediaType) || '').toLowerCase();
  if (mediaType === 'video') return 'video';
  const fileName = String((post && (post.fileName || post.mediaPath || post.videoPath)) || '').toLowerCase();
  if (['.mp4', '.mov', '.webm'].some(ext => fileName.endsWith(ext))) return 'video';
  return 'photo';
}

function getPostMediaPath(post) {
  if (!post) return '';
  if (getPostMediaType(post) === 'video') return post.videoPath || post.mediaPath || post.imagePath || '';
  return post.imagePath || post.mediaPath || '';
}

function buildPostResultView(post) {
  const lastResult = post && post.lastResult ? post.lastResult : null;
  const responseSource = lastResult ? lastResult.response || lastResult : null;
  const metadata = getPublishMetadata(responseSource);
  const shareUrl = getFirstValue(responseSource, ['share_url','shareUrl','post_url','postUrl','permalink','public_url','publicUrl']);
  const publishId = getFirstValue(responseSource, ['publish_id','publishId']);
  const status = String((post && post.status) || 'pending').toLowerCase();
  const isApiAccepted = Boolean(lastResult && lastResult.ok && lastResult.mode === 'api');
  const debugJson = getDebugJson(post);

  let stateLabel = 'Scheduled', tone = 'scheduled';
  let message = post && post.scheduledAt ? `Scheduled for ${viewHelpers.formatDateTime(post.scheduledAt)}.` : 'Waiting for a schedule time.';

  if (status === 'publishing') {
    stateLabel = 'Publishing'; tone = 'publishing';
    message = 'Publishing to TikTok. Large videos can take a moment.';
  } else if (status === 'failed' || (lastResult && lastResult.ok === false && lastResult.mode !== 'manual')) {
    stateLabel = 'Failed'; tone = 'failed';
    const rawReason = (lastResult && lastResult.reason) || '';
    const fullJson = lastResult ? JSON.stringify(lastResult) : '';
    const isUnaudited = rawReason.includes('unaudited_client_can_only_post_to_private_accounts') || rawReason.includes('403') || fullJson.includes('unaudited_client_can_only_post_to_private_accounts');
    message = isUnaudited
      ? 'TikTok blocked this because the app is not reviewed yet. Until approval, test posting may require a private TikTok account.'
      : rawReason || 'TikTok rejected the publish request.';
  } else if (status === 'ready' || (lastResult && lastResult.mode === 'manual' && status !== 'posted')) {
    stateLabel = 'Needs manual verification'; tone = 'verification';
    message = (lastResult && lastResult.reason) || 'Open the media and verify or post inside TikTok.';
  } else if (status === 'posted' && isApiAccepted) {
    stateLabel = 'Posted / API accepted'; tone = shareUrl ? 'accepted' : 'verification';
    message = shareUrl ? 'TikTok returned a public post URL.' : 'TikTok accepted the publish request, but no public post URL was returned. Please verify inside TikTok.';
  } else if (status === 'posted') {
    stateLabel = 'Posted manually'; tone = 'accepted';
    message = (lastResult && lastResult.reason) || 'This item was marked posted manually.';
  }

  return { stateLabel, tone, message, metadata, shareUrl, publishId, debugJson, hasDebug: Boolean(debugJson), hasAttempt: Boolean(lastResult), statusCheckAvailable: false };
}

function buildInstagramPostResultView(post) {
  const lastResult = post && post.lastInstagramResult ? post.lastInstagramResult : null;
  const debugJson = getInstagramDebugJson(post);
  if (!lastResult) return { stateLabel: 'No Instagram test', tone: 'scheduled', message: '', metadata: [], debugJson, hasDebug: false, hasAttempt: false };

  const metadata = getPublishMetadata(lastResult.response || lastResult);
  let stateLabel = 'Instagram tested', tone = 'verification', message = lastResult.reason || 'Instagram container created in test mode.';

  if (!lastResult.ok) {
    stateLabel = 'Instagram failed'; tone = lastResult.mode === 'manual' ? 'verification' : 'failed';
    message = lastResult.reason || 'Instagram rejected the request.';
  } else if (lastResult.published) {
    stateLabel = 'Instagram published'; tone = 'accepted';
    message = lastResult.reason || 'Instagram accepted the publish request.';
  }

  return { stateLabel, tone, message, metadata, debugJson, hasDebug: Boolean(debugJson), hasAttempt: true };
}

function getPublishMetadata(source) {
  if (!source) return [];
  const rows = [
    ['Publish ID', getFirstValue(source, ['publish_id','publishId'])],
    ['Post ID', getFirstValue(source, ['post_id','postId','item_id','itemId','video_id','videoId'])],
    ['Share URL', getFirstValue(source, ['share_url','shareUrl','post_url','postUrl','permalink','public_url','publicUrl'])],
    ['Status', getFirstValue(source, ['status','publish_status','publishStatus'])],
    ['Log ID', getFirstValue(source, ['log_id','logId'])]
  ];
  return rows.filter(r => r[1] !== undefined && r[1] !== null && String(r[1]).trim() !== '')
    .map(([label, value]) => ({ label, value: formatMetadataValue(value), isUrl: isHttpUrl(value) }));
}

function getFirstValue(source, keys) {
  const found = findValuesByKeys(source, new Set(keys.map(k => k.toLowerCase())));
  return found.length > 0 ? found[0] : '';
}

function findValuesByKeys(value, keySet, found = []) {
  if (!value || typeof value !== 'object') return found;
  if (Array.isArray(value)) { value.forEach(i => findValuesByKeys(i, keySet, found)); return found; }
  Object.entries(value).forEach(([k, v]) => {
    if (keySet.has(k.toLowerCase())) found.push(v);
    if (v && typeof v === 'object') findValuesByKeys(v, keySet, found);
  });
  return found;
}

function formatMetadataValue(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function isHttpUrl(value) {
  try { const u = new URL(String(value)); return u.protocol === 'http:' || u.protocol === 'https:'; }
  catch { return false; }
}

function getDebugJson(post) { return post && post.lastResult ? JSON.stringify(post.lastResult, null, 2) : ''; }
function getInstagramDebugJson(post) { return post && post.lastInstagramResult ? JSON.stringify(post.lastInstagramResult, null, 2) : ''; }

function statusLabel(status) {
  const labels = { pending: 'Scheduled', publishing: 'Publishing', ready: 'Needs manual verification', posted: 'Posted', failed: 'Failed' };
  const v = String(status || 'pending').toLowerCase();
  return labels[v] || `${v.charAt(0).toUpperCase()}${v.slice(1)}`;
}

function saveInstagramAttempt(postId, result) {
  if (!postId) return;
  const post = storage.getPost(postId);
  if (!post) return;
  storage.updatePost(postId, { lastInstagramResult: { ...result, completedAt: new Date().toISOString() } });
}

function instagramNotice(result) {
  if (result.ok && result.published) return 'Instagram accepted the publish request.';
  if (result.ok) return 'Instagram test completed. Container created; public publish skipped.';
  if (result.mode === 'manual') return result.reason || 'Instagram needs a public media URL before testing.';
  return `Instagram attempt failed: ${result.reason || 'Unknown error'}`;
}

function wantsJson(req) {
  const accept = String(req.headers.accept || '').toLowerCase();
  const ct = String(req.headers['content-type'] || '').toLowerCase();
  return accept.includes('application/json') || ct.includes('application/json');
}

module.exports = router;
