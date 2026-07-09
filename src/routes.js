const express = require('express');
const multer = require('multer');
const fs = require('fs/promises');
const path = require('path');
const { randomUUID } = require('crypto');
const config = require('./config');
const storage = require('./storage');
const scheduler = require('./scheduler');
const autoCaption = require('./autoCaption');
const autoMusic = require('./autoMusic');
const tiktok = require('./tiktok');
const instagram = require('./instagram');
const { parseDateTimeLocal } = require('./timeUtil');
const { computeMaxSchedulePlan, DEFAULT_OFFSET_MINUTES } = require('./maxScheduler');
const { summarizeCampaigns, latestCampaignChannelCount } = require('./campaignAccounting');
const clientRoutes = require('./clientRoutes');
const {
  clearAdminSessionCookie,
  requireAdminApi,
  requireAdminOAuth,
  requireAdminPage,
  resolveUserId,
  safeReturnTo,
  setAdminSessionCookie,
  verifyAdminPassword
} = require('./auth');

const router = express.Router();
const ACTIVE_TIKTOK_ACCOUNT_COOKIE = 'autoposter_tiktok_account_id';
const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;

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

const autoCaptionUpload = multer({
  storage: multer.diskStorage({
    destination: config.uploadsDir,
    filename: (req, file, callback) => {
      const extension = path.extname(file.originalname || '').toLowerCase() || defaultExtension(file);
      callback(null, `caption-${Date.now()}-${randomUUID()}${extension}`);
    }
  }),
  fileFilter: (req, file, callback) => {
    const mime = String(file.mimetype || '').toLowerCase();
    const extension = path.extname(file.originalname || '').toLowerCase();
    if (mime.startsWith('video/') || ['.mp4', '.mov', '.webm'].includes(extension)) {
      callback(null, true);
      return;
    }
    callback(new Error('Auto Caption requires an MP4, MOV, or WebM video.'));
  },
  limits: { files: 1, fileSize: 250 * 1024 * 1024 }
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

// Firestore calls are async; Express 4 won't forward a rejected promise to
// the error middleware on its own, so every handler that awaits storage/
// tiktok/instagram is wrapped in this instead of being declared directly
// as the route callback.
function asyncRoute(handler) {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}

function countsFromPosts(posts) {
  return posts.reduce(
    (counts, post) => {
      counts.total += 1;
      counts[post.status] = (counts[post.status] || 0) + 1;
      return counts;
    },
    { total: 0, pending: 0, scheduled: 0, processing: 0, ready: 0, posted: 0, failed: 0 }
  );
}

// Release Queue view mode: "active" (today's behavior, scoped to the
// currently selected TikTok channel) or "all" (every channel, grouped by
// campaign). getPosts(userId) with no accountId already reads every post
// for this user in one Firestore query — getPosts(userId, accountId) just
// filters the same result client-side — so resolving both modes from one
// fetch costs nothing extra over the old single-channel-only fetch.
function resolveQueueView(req, allPosts) {
  const requested = String(req.query.queueView || '').trim().toLowerCase();
  if (requested === 'all' || requested === 'active') return requested;
  return latestCampaignChannelCount(allPosts) > 1 ? 'all' : 'active';
}

const renderAutoPoster = asyncRoute(async (req, res) => {
  const userId = resolveUserId(req);
  const { accounts, activeAccount } = await resolveTikTokAccountContext(req, res);
  const activeAccountId = activeAccount ? activeAccount.accountId : '';
  // Two calls, not one filtered locally: storage.getPosts(userId, accountId)
  // is the long-standing, widely-mocked single-channel contract, so the
  // "active" view keeps using it completely unchanged. The unscoped call is
  // only for "All Channels" and for picking the default view — a narrower
  // test double that only understands the single-channel form (i.e. one
  // that doesn't handle "no accountId means every channel") just yields no
  // multi-channel signal, which safely resolves to the same "active" default.
  const activeAccountPosts = activeAccountId ? await storage.getPosts(userId, activeAccountId) : [];
  const allPosts = await storage.getPosts(userId);
  const queueView = resolveQueueView(req, allPosts);
  const posts = queueView === 'all' ? allPosts : activeAccountPosts;
  const tiktokAuthStatus = await tiktok.getTikTokAuthStatus(activeAccountId, userId);
  const instagramStatus = config.ENABLE_INSTAGRAM
    ? await instagram.getInstagramAuthStatus()
    : null;
  const instagramHealth = await instagram.getInstagramHealth();
  const creatorInfo = tiktokAuthStatus.connected
    ? (await getCreatorInfoSafe(activeAccountId, userId)) || creatorInfoFromAccount(activeAccount)
    : creatorInfoFromAccount(activeAccount);

  // Refresh stored profile when TikTok reports a renamed handle.
  if (creatorInfo && creatorInfo.creator_username && activeAccount
      && creatorInfo.creator_username !== activeAccount.username) {
    const profile = {
      username: creatorInfo.creator_username,
      displayName: creatorInfo.creator_nickname || '',
      avatarUrl: creatorInfo.creator_avatar_url || ''
    };
    try {
      await storage.updateTikTokAccountProfile(userId, activeAccount.accountId, profile);
    } catch (refreshError) {
      console.warn('[routes] profile refresh after render load failed', refreshError.message);
    }
    activeAccount.username = profile.username;
    activeAccount.displayName = profile.displayName;
    activeAccount.avatarUrl = profile.avatarUrl;
    // activeAccount is a reference into the accounts array, so mutating it
    // updates the Switch Channel dropdown and Target Publishing Channels too.
  }

  res.render('index', {
    appName: config.appName,
    posts,
    queueView,
    campaignSummaries: queueView === 'all' ? summarizeCampaigns(posts) : [],
    todayPost: getTodayPost(posts),
    settings: await storage.getSettings(),
    counts: queueView === 'all'
      ? countsFromPosts(allPosts)
      : (activeAccountId ? await storage.getCounts(userId, activeAccountId) : emptyPostCounts()),
    notice: req.query.notice || '',
    tiktokConfigured: tiktokAuthStatus.connected,
    tiktokAuthStatus,
    tiktokAccounts: accounts.map(publicTikTokAccount),
    activeTikTokAccount: activeAccount ? publicTikTokAccount(activeAccount) : null,
    enableInstagram: config.ENABLE_INSTAGRAM,
    autoCaptionConfigured: autoCaption.hasConfiguredCaptionProvider(),
    autoMusicConfigured: autoMusic.isAutoMusicConfigured(),
    defaultOffsetMinutes: DEFAULT_OFFSET_MINUTES,
    instagramStatus,
    instagramHealth,
    creatorInfo,
    helpers: viewHelpers
  });
});

router.get('/admin-login', (req, res) => {
  if (req.isAdmin) {
    res.redirect(safeReturnTo(req.query.returnTo));
    return;
  }
  res.set('Cache-Control', 'no-store');
  res.render('admin-login', {
    appName: config.appName,
    error: '',
    notice: String(req.query.notice || ''),
    returnTo: safeReturnTo(req.query.returnTo)
  });
});

router.post('/admin-login', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const attempt = getLoginAttempt(req.ip);
  const returnTo = safeReturnTo(req.body.returnTo);
  if (attempt.locked) {
    res.status(429).render('admin-login', {
      appName: config.appName,
      error: 'Too many login attempts. Try again in 15 minutes.',
      notice: '',
      returnTo
    });
    return;
  }

  if (!verifyAdminPassword(req.body.password)) {
    recordFailedLogin(req.ip);
    res.status(401).render('admin-login', {
      appName: config.appName,
      error: 'Incorrect admin password.',
      notice: '',
      returnTo
    });
    return;
  }

  loginAttempts.delete(req.ip);
  setAdminSessionCookie(req, res);
  res.redirect(returnTo);
});

router.post('/logout', requireAdminPage, (req, res) => {
  clearAdminSessionCookie(req, res);
  res.clearCookie(ACTIVE_TIKTOK_ACCOUNT_COOKIE);
  res.redirect('/admin-login?notice=You+have+been+logged+out.');
});

router.get('/', requireAdminPage, renderAutoPoster);
router.get('/private/autoposter', requireAdminPage, renderAutoPoster);

router.get('/private/autoposter/dashboard', requireAdminPage, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'autoposter-dashboard', 'dashboard.html'));
});

router.get('/api/private/autoposter/dashboard', requireAdminApi, asyncRoute(async (req, res) => {
  const userId = resolveUserId(req);
  const [jobs, accountContext] = await Promise.all([
    storage.getDashboardJobs(userId),
    resolveTikTokAccountContext(req, res)
  ]);
  const { accounts, activeAccount } = accountContext;
  const selectedAccountId = activeAccount ? activeAccount.accountId : '';

  res.set('Cache-Control', 'no-store');
  res.json({
    ok: true,
    accounts: accounts.map(publicTikTokAccount),
    selectedAccountId,
    jobs,
    appTimeZone: config.appTimeZone
  });
}));

router.get('/health', asyncRoute(async (req, res) => {
  const schedulerHealth = await scheduler.getSchedulerHealth();
  res.json({
    ok: true,
    app: config.appName,
    uptimeSeconds: Math.round(process.uptime()),
    currentTime: new Date().toISOString(),
    appTimeZone: config.appTimeZone,
    scheduler: scheduler.getSchedulerState(),
    schedulerHealth,
    cronTrigger: Boolean(config.cronSecret),
    autoCaptionConfigured: autoCaption.hasConfiguredCaptionProvider(),
    autoMusicConfigured: autoMusic.isAutoMusicConfigured()
  });
}));

router.get('/api/storage/health', asyncRoute(async (req, res) => {
  if (!authorizeCronRequest(req, res, 'debug')) return;

  const result = await storage.checkMediaStorageHealth({ writeTest: req.query.write === '1' });
  res.status(result.ok ? 200 : 503).json(result);
}));

router.get('/api/cron/tick', asyncRoute(runCronTick));

// Compatibility endpoint for existing Render cron jobs during deployment.
router.get('/run-scheduler', asyncRoute(runCronTick));

router.get('/api/debug/jobs', asyncRoute(async (req, res) => {
  if (!authorizeCronRequest(req, res, 'debug')) return;
  const jobs = await storage.getRecentJobs(req.query.limit);
  res.json({
    ok: true,
    jobs: jobs.map((job) => ({
      id: job.id,
      status: job.status,
      scheduledAt: job.scheduledAt,
      title: firstNonEmptyLine(job.caption) || job.originalName || job.fileName || 'Untitled',
      privacy: job.privacyLevel,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt
    }))
  });
}));

router.post('/private/autoposter/account', requireAdminPage, asyncRoute(async (req, res) => {
  const userId = resolveUserId(req);
  const accountId = String(req.body.accountId || '').trim();
  const account = await storage.getTikTokAccount(userId, accountId);
  if (!account) {
    redirectWithNotice(res, 'TikTok account not found.');
    return;
  }
  setActiveTikTokAccountCookie(res, account.accountId);
  redirectWithNotice(res, `Active TikTok account changed to ${accountLabel(account)}.`);
}));

// Generates a brand-new client access code for one TikTok account and
// shows it exactly once, in the response body (never in a URL/query
// string, which would leak into browser history and server access logs).
// Only the code's hash is ever persisted — see storage.generateClientAccessCode.
router.post('/private/autoposter/account/:accountId/client-access', requireAdminPage, asyncRoute(async (req, res) => {
  const userId = resolveUserId(req);
  const accountId = String(req.params.accountId || '').trim();
  const code = await storage.generateClientAccessCode(userId, accountId);
  if (!code) {
    redirectWithNotice(res, 'TikTok account not found.');
    return;
  }
  const account = await storage.getTikTokAccount(userId, accountId);
  res.set('Cache-Control', 'no-store');
  res.render('client-access-generated', {
    appName: config.appName,
    account,
    code,
    accountLabelText: accountLabel(account)
  });
}));

router.post('/private/autoposter/account/:accountId/client-access/revoke', requireAdminPage, asyncRoute(async (req, res) => {
  const userId = resolveUserId(req);
  const accountId = String(req.params.accountId || '').trim();
  const revoked = await storage.revokeClientAccessCode(userId, accountId);
  redirectWithNotice(res, revoked ? 'Client access revoked. The old code no longer works.' : 'TikTok account not found.');
}));

router.get('/connect/tiktok', requireAdminPage, (req, res) => {
  if (!config.tiktok.clientKey || !config.tiktok.clientSecret || !config.tiktok.redirectUri) {
    redirectWithNotice(res, 'Add TikTok client key, secret, and redirect URI to .env first.');
    return;
  }
  const state = randomUUID();
  // Clear only this browser's selected-account state. Existing account
  // records, tokens, jobs, and history remain untouched in Firestore.
  res.clearCookie(ACTIVE_TIKTOK_ACCOUNT_COOKIE);
  res.cookie('tiktok_oauth_state', state, { httpOnly: true, sameSite: 'lax', maxAge: 10 * 60 * 1000 });
  res.redirect(tiktok.buildTikTokAuthUrl(state));
});

// TikTok's redirect_uri is a single fixed URL (config.tiktok.redirectUri),
// so it's shared by the admin "connect a channel" flow below and the
// client "reconnect my channel" flow in clientRoutes.js. The client flow
// sets its own state cookie before redirecting to TikTok; if that cookie
// is present, this dispatches to the client's isolated handler (which
// enforces its own session + fail-closed account re-check) instead of
// running the admin logic. Everything below this check is the original,
// unmodified admin-only flow.
router.get('/auth/tiktok/callback', asyncRoute(async (req, res) => {
  if (parseCookies(req.headers.cookie)[clientRoutes.CLIENT_OAUTH_STATE_COOKIE]) {
    await clientRoutes.handleTikTokReconnectCallback(req, res);
    return;
  }
  if (!req.isAdmin) {
    res.redirect('/admin-login?notice=Your+admin+session+expired.+Log+in+and+connect+TikTok+again.');
    return;
  }
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
    const userId = resolveUserId(req);
    const auth = await tiktok.exchangeCodeForToken(String(req.query.code));
    let account = await storage.saveTikTokAccount(userId, auth);
    try {
      const profile = await tiktok.queryCreatorInfo(account.accountId, userId);
      account = await storage.updateTikTokAccountProfile(userId, account.accountId, profile) || account;
    } catch (profileError) {
      console.warn('[routes] TikTok profile unavailable after OAuth', profileError.message);
    }
    setActiveTikTokAccountCookie(res, account.accountId);
    redirectWithNotice(res, `TikTok account ${accountLabel(account)} connected and selected.`);
  } catch (error) {
    redirectWithNotice(res, `TikTok connection failed: ${error.message}`);
  }
}));

router.get('/disconnect/tiktok', requireAdminPage, asyncRoute(async (req, res) => {
  const userId = resolveUserId(req);
  const { activeAccount } = await resolveTikTokAccountContext(req, res);
  if (!activeAccount) {
    redirectWithNotice(res, 'No TikTok account is selected.');
    return;
  }
  await storage.disconnectTikTokAccount(userId, activeAccount.accountId);
  res.clearCookie(ACTIVE_TIKTOK_ACCOUNT_COOKIE);
  redirectWithNotice(res, `${accountLabel(activeAccount)} disconnected. Its jobs and history were preserved.`);
}));

router.get('/auth/instagram/start', requireAdminPage, (req, res) => {
  if (!instagram.hasOAuthConfig()) {
    redirectWithNotice(res, 'Add Meta app ID, app secret, and redirect URI to .env first.');
    return;
  }
  const state = randomUUID();
  res.cookie('instagram_oauth_state', state, { httpOnly: true, sameSite: 'lax', maxAge: 10 * 60 * 1000 });
  res.redirect(instagram.buildInstagramAuthUrl(state));
});

router.get('/auth/instagram/callback', requireAdminOAuth, asyncRoute(async (req, res) => {
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
    await storage.saveInstagramAuth(auth);
    redirectWithNotice(res, 'Instagram connected.');
  } catch (error) {
    redirectWithNotice(res, `Instagram connection failed: ${error.message}`);
  }
}));

router.get('/disconnect/instagram', requireAdminPage, asyncRoute(async (req, res) => {
  await storage.clearInstagramAuth();
  redirectWithNotice(res, 'Instagram disconnected.');
}));

router.get('/api/instagram/health', asyncRoute(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await instagram.getInstagramHealth());
}));

router.get('/api/instagram/status', requireAdminApi, asyncRoute(async (req, res) => {
  const status = await instagram.getInstagramAuthStatus();
  const containerId = String(req.query.containerId || '').trim();
  if (!containerId) { res.json({ ok: true, instagram: status }); return; }
  try {
    const container = await instagram.getContainerStatus(containerId);
    res.json({ ok: true, instagram: status, container });
  } catch (error) {
    res.status(400).json({ ok: false, instagram: status, reason: error.message, response: error.response || null });
  }
}));

router.post('/api/instagram/publish', requireAdminApi, express.json({ limit: '1mb' }), asyncRoute(async (req, res) => {
  const userId = resolveUserId(req);
  const payload = { ...(req.body || {}), postId: String((req.body && req.body.postId) || '').trim(), userId };
  try {
    const result = await instagram.publishInstagramMedia(payload);
    await saveInstagramAttempt(userId, payload.postId, result);
    if (result.code === 'INSTAGRAM_NOT_CONFIGURED' && wantsJson(req)) {
      res.status(503).json({
        success: false,
        platform: 'instagram',
        code: result.code,
        message: result.message,
        missing: result.missing
      });
      return;
    }
    if (wantsJson(req)) { res.status(result.ok ? 200 : 400).json({ ok: result.ok, result }); return; }
    redirectWithNotice(res, instagramNotice(result));
  } catch (error) {
    if (error.code === 'INSTAGRAM_NOT_CONFIGURED' && wantsJson(req)) {
      res.status(503).json({
        success: false,
        platform: 'instagram',
        code: error.code,
        message: error.message,
        missing: Array.isArray(error.missing) ? error.missing : []
      });
      return;
    }
    const result = { ok: false, mode: 'api', published: false, reason: error.message, response: error.response || null };
    await saveInstagramAttempt(userId, payload.postId, result);
    if (wantsJson(req)) { res.status(400).json({ ok: false, result }); return; }
    redirectWithNotice(res, `Instagram attempt failed: ${error.message}`);
  }
}));

router.post(
  '/api/auto-caption',
  requireAdminApi,
  autoCaptionUpload.single('video'),
  asyncRoute(async (req, res) => {
    const draft = {
      caption: String(req.body.caption || '').trim(),
      hashtags: String(req.body.hashtags || '').trim()
    };

    if (!req.file) {
      res.status(400).json({
        ok: false,
        reason: 'Choose a video before running Auto Caption.',
        requiresManualCaption: !draft.caption
      });
      return;
    }

    try {
      const result = await autoCaption.analyzeVideoForCaption(req.file.path, draft, {
        filename: req.file.originalname
      });
      const autoMusicRequested = String(req.body.autoMusic || '') === '1';
      let music = {
        requested: autoMusicRequested,
        prepared: false,
        fallbackToOriginal: false,
        token: '',
        track: null
      };

      if (autoMusicRequested) {
        try {
          const preparedMusic = await autoMusic.prepareAutoMusic({
            videoPath: req.file.path,
            originalName: req.file.originalname,
            originalSize: req.file.size,
            userId: resolveUserId(req),
            analysis: {
              metadata: result.metadata,
              musicCategory: result.musicCategory,
              musicMood: result.musicMood,
              musicIntensity: result.musicIntensity,
              musicTags: result.musicTags
            }
          });
          music = {
            requested: true,
            prepared: true,
            fallbackToOriginal: false,
            token: preparedMusic.token,
            track: preparedMusic.track,
            mix: {
              originalAudioKept: preparedMusic.render.hasOriginalAudio,
              musicVolume: preparedMusic.render.musicVolume,
              durationSeconds: preparedMusic.render.durationSeconds
            }
          };
        } catch (error) {
          console.error('[auto-music] preparation failed; original video will be used', {
            code: error.code || 'AUTO_MUSIC_FAILED',
            message: error.message,
            fileName: req.file.originalname
          });
          music = {
            requested: true,
            prepared: false,
            fallbackToOriginal: true,
            token: '',
            track: null,
            reason: 'Background music could not be mixed. The original video will be used.'
          };
        }
      }

      res.json({
        ok: true,
        caption: result.caption,
        hashtags: result.hashtags,
        generatedCaption: result.generatedCaption,
        hook: result.hook,
        hashtagList: result.hashtagList,
        analysis: {
          frameCount: 5,
          transcriptUsed: result.transcriptUsed,
          transcriptionWarning: result.transcriptionWarning || '',
          analysisWarning: result.analysisWarning || '',
          provider: result.provider,
          fallbackUsed: result.fallbackUsed,
          musicCategory: result.musicCategory,
          musicMood: result.musicMood,
          musicIntensity: result.musicIntensity,
          metadata: result.metadata
        },
        music
      });
    } catch (error) {
      console.error('[auto-caption] analysis failed', {
        code: error.code || 'AUTO_CAPTION_FAILED',
        message: error.message,
        fileName: req.file.originalname
      });
      res.status(error.code === 'AUTO_CAPTION_NOT_CONFIGURED' ? 503 : 422).json({
        ok: false,
        code: error.code || 'AUTO_CAPTION_FAILED',
        reason: draft.caption
          ? 'Auto Caption could not analyze this video. Your manual caption was kept.'
          : 'Auto Caption could not analyze this video. Write a caption before scheduling.',
        fallback: draft,
        requiresManualCaption: !draft.caption
      });
    } finally {
      await removeTemporaryUpload(req.file.path);
    }
  })
);

router.post('/upload', requireConnectedTikTokAccount, upload.array('images'), asyncRoute(async (req, res) => {
  const userId = resolveUserId(req);
  const account = req.activeTikTokAccount;
  const files = req.files || [];
  const publicMediaUrl = String(req.body.publicMediaUrl || req.body.publicImageUrl || '').trim();
  if (publicMediaUrl && !isPublicHttpsUrl(publicMediaUrl)) {
    respondWithNotice(req, res, 'Public Media URL must be a valid HTTPS URL.', false);
    return;
  }
  if (files.length === 0 && !publicMediaUrl) {
    respondWithNotice(req, res, 'Choose a media file or enter a Public Media URL.', false);
    return;
  }

  // Multi-channel scheduling: the form may submit one or more target
  // Publishing Channels. When absent, the active channel is the single
  // target — identical to the pre-multichannel behavior.
  let targetAccounts = [account];
  const requestedChannelIds = normalizeTargetChannelIds(req.body.targetChannels);
  if (requestedChannelIds.length > 0) {
    const allAccounts = await storage.getTikTokAccounts(userId);
    const accountsById = new Map(allAccounts.map((item) => [item.accountId, item]));
    const resolved = [];
    for (const channelId of requestedChannelIds) {
      const target = accountsById.get(channelId);
      if (!target) {
        respondWithNotice(req, res, 'One of the selected publishing channels was not found. Refresh and try again.', false);
        return;
      }
      if (!target.connected) {
        respondWithNotice(req, res, `${accountLabel(target)} needs to be reconnected before it can post.`, false);
        return;
      }
      resolved.push(target);
    }
    targetAccounts = resolved;
  }

  // Max Scheduler: an explicit campaign start date/time turns on
  // start-time + per-channel-offset scheduling instead of the legacy
  // "tomorrow at the daily release window, per channel" auto-schedule.
  // Preflight (no channels / disconnected channels) is validated before any
  // job is created, so a bad plan never leaves partial jobs behind.
  const startDate = String(req.body.startDate || '').trim();
  const startTime = String(req.body.startTime || '').trim();
  const useMaxScheduler = Boolean(startDate && startTime);
  let maxSchedulePlan = null;
  if (useMaxScheduler) {
    maxSchedulePlan = computeMaxSchedulePlan({
      startDate,
      startTime,
      timezoneOffsetMinutes: req.body.timezoneOffsetMinutes,
      offsetMinutes: req.body.offsetMinutes,
      channels: targetAccounts.map((target) => ({
        accountId: target.accountId,
        tiktokOpenId: target.open_id,
        username: target.username,
        connected: target.connected
      }))
    });
    if (!maxSchedulePlan.ok) {
      respondWithNotice(req, res, maxSchedulePlan.reason, false);
      return;
    }
  }

  const preparedMedia = resolvePreparedMedia(req.body.autoMusicToken, userId, files);
  const created = await storage.addUploadedPosts(userId, files, {
    caption: req.body.caption,
    hashtags: req.body.hashtags,
    publicMediaUrl,
    accounts: targetAccounts.map((target) => ({
      accountId: target.accountId,
      tiktokOpenId: target.open_id,
      username: target.username
    })),
    // Legacy single-account fields, kept as the fallback contract.
    accountId: account.accountId,
    tiktokOpenId: account.open_id,
    username: account.username,
    preparedMedia
  });

  let scheduledCount = 0;
  if (useMaxScheduler) {
    scheduledCount = await storage.applyExplicitSchedule(userId, created, maxSchedulePlan);
  } else {
    // Auto-schedule each channel's queue independently so one channel's
    // release cadence never shifts another channel's.
    for (const target of targetAccounts) {
      const channelPostIds = created
        .filter((post) => post.accountId === target.accountId)
        .map((post) => post.id);
      scheduledCount += await storage.autoSchedulePosts(userId, channelPostIds, target.accountId);
    }
  }

  const usedFallback = created.some((post) => post.storageFallback);
  const sourceNotice = usedFallback ? ' Upload failed, so the public URL was used instead.' : '';
  const musicNotice = created.some((post) => post.autoMusicApplied)
    ? ' Background music was added.'
    : (req.body.autoMusicToken ? ' Music could not be added, so the original video was used.' : '');
  const channelNotice = targetAccounts.length > 1
    ? ` across ${targetAccounts.length} channels`
    : ` for ${accountLabel(targetAccounts[0])}`;
  const scheduleNotice = useMaxScheduler
    ? ` First post at ${viewHelpers.formatDateTime(maxSchedulePlan.baseAt)}, ${maxSchedulePlan.offsetMinutes}m apart per channel.`
    : '';
  const duplicateCount = created.filter((post) => post.duplicateWarning).length;
  const duplicateNotice = duplicateCount > 0
    ? ` ${duplicateCount} flagged as ${duplicateCount === 1 ? 'a possible duplicate' : 'possible duplicates'} — check the warnings below.`
    : '';
  respondWithNotice(req, res, `Created ${created.length} ${created.length === 1 ? 'post' : 'posts'}${channelNotice}. ${scheduledCount} scheduled as ${scheduledCount === 1 ? 'a draft' : 'drafts'} — review and approve in the Release Queue before anything publishes.${scheduleNotice}${sourceNotice}${musicNotice}${duplicateNotice}`);
}));

router.post('/settings', requireAdminPage, asyncRoute(async (req, res) => {
  const dailyPostTime = String(req.body.dailyPostTime || '').trim();
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(dailyPostTime)) { redirectWithNotice(res, 'Use a valid daily posting time.'); return; }
  await storage.saveSettings({ dailyPostTime });
  redirectWithNotice(res, `Posting time set to ${dailyPostTime}.`);
}));

router.post('/schedule', requireConnectedTikTokAccount, asyncRoute(async (req, res) => {
  const userId = resolveUserId(req);
  const count = await storage.reschedulePendingQueue(userId, req.activeTikTokAccount.accountId);
  redirectWithNotice(res, `Scheduled ${count}.`);
}));

// ── Updated post save — now captures interaction settings & content disclosure ──
router.post('/posts/:id', requireConnectedTikTokAccount, asyncRoute(async (req, res) => {
  const userId = resolveUserId(req);
  const scheduledAt = parseDateTimeLocal(req.body.scheduledAt, req.body.timezoneOffsetMinutes);
  const publicMediaUrl = String(req.body.publicMediaUrl || req.body.publicImageUrl || '').trim();
  if (publicMediaUrl && !isPublicHttpsUrl(publicMediaUrl)) {
    redirectWithNotice(res, 'Public Media URL must be a valid HTTPS URL.');
    return;
  }

  // Interaction ability: checkbox presence means enabled
  const allowComment    = req.body.allowComment    === '1';
  const allowDuet       = req.body.allowDuet       === '1';
  const allowStitch     = req.body.allowStitch      === '1';

  // Content disclosure
  const contentDisclosure = req.body.contentDisclosure === '1';
  const yourBrand         = contentDisclosure && req.body.yourBrand      === '1';
  const brandedContent    = contentDisclosure && req.body.brandedContent === '1';

  const postPatch = {
    caption:            String(req.body.caption            || '').trim(),
    hashtags:           String(req.body.hashtags           || '').trim(),
    publicMediaUrl,
    publicImageUrl:     publicMediaUrl,
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
  };

  if (config.ENABLE_INSTAGRAM) {
    postPatch.instagramMediaUrl = String(req.body.instagramMediaUrl || '').trim();
  }

  await storage.updatePost(userId, req.params.id, postPatch, req.activeTikTokAccount.accountId,
    { event: 'edited', detail: 'Caption, schedule, or settings updated in the Release Queue.' });

  redirectWithNotice(res, 'Saved.');
}));

router.post('/posts/:id/move', requireConnectedTikTokAccount, asyncRoute(async (req, res) => {
  const userId = resolveUserId(req);
  const moved = await storage.movePost(userId, req.params.id, req.body.direction, req.activeTikTokAccount.accountId);
  redirectWithNotice(res, moved ? 'Moved.' : 'Could not move item.');
}));

// ── Approval gate: the explicit human review actions ──
// Approving is the only way a job becomes publishable; scheduler.claimPost
// refuses unapproved jobs on every worker path, so these two routes are
// the entire surface area a human uses to open or close the gate.
router.post('/posts/:id/approve', requireConnectedTikTokAccount, asyncRoute(async (req, res) => {
  const userId = resolveUserId(req);
  const approved = await storage.approvePost(userId, req.params.id, { approvedBy: `admin:${userId}` }, req.activeTikTokAccount.accountId);
  if (!approved) {
    redirectWithNotice(res, 'Could not approve this post. It may be posting, already posted, or not in this channel.');
    return;
  }
  redirectWithNotice(res, approved.scheduledAt
    ? `Approved. It will post at ${viewHelpers.formatDateTime(approved.scheduledAt)}.`
    : 'Approved. Set a posting time or use Publish Now to release it.');
}));

router.post('/posts/:id/unapprove', requireConnectedTikTokAccount, asyncRoute(async (req, res) => {
  const userId = resolveUserId(req);
  const revoked = await storage.revokePostApproval(userId, req.params.id, req.activeTikTokAccount.accountId);
  redirectWithNotice(res, revoked
    ? 'Approval removed. This post is blocked from publishing until you approve it again.'
    : 'Could not change approval. The post may be posting, already posted, or not in this channel.');
}));

router.post('/posts/:id/prepare', requireConnectedTikTokAccount, asyncRoute(async (req, res) => {
  const userId = resolveUserId(req);
  const post = await storage.getPost(userId, req.params.id, req.activeTikTokAccount.accountId);
  if (!post) { redirectWithNotice(res, 'Post not found.'); return; }

  // Fail closed before any publish attempt: unapproved drafts can never be
  // published, even by the manual Publish Now action. (scheduler.claimPost
  // enforces the same gate transactionally — this check just gives the
  // operator a clear message instead of a generic skip.)
  if (!post.approved) {
    redirectWithNotice(res, 'Approve this post first — drafts are blocked from publishing until a human approves them.');
    return;
  }

  const forcePostNow = String(req.body.force || '') === '1';
  const scheduledAt = post.scheduledAt ? new Date(post.scheduledAt) : null;

  if (!forcePostNow && scheduledAt && scheduledAt.getTime() > Date.now()) {
    redirectWithNotice(res, `Scheduled for ${viewHelpers.formatDateTime(post.scheduledAt)}. It will post automatically at that time.`);
    return;
  }

  // Routes through the same claim-then-publish transaction the automatic
  // scheduler uses (force: true just skips the "is it due yet" check) —
  // so a double-click here can't trigger a double-publish either.
  const result = await scheduler.processPost(req.params.id, { force: true });
  if (result.ok) { redirectWithNotice(res, 'Posted. Check the status below to confirm.'); return; }
  if (result.mode === 'manual') { redirectWithNotice(res, 'Needs attention — see the note on this post below.'); return; }
  if (result.mode === 'skipped') { redirectWithNotice(res, 'Already posting — give it a moment and check the status below.'); return; }
  redirectWithNotice(res, `Needs attention: ${result.reason || 'TikTok could not post this.'}`);
}));

router.post('/posts/:id/posted', requireConnectedTikTokAccount, asyncRoute(async (req, res) => {
  const userId = resolveUserId(req);
  const now = new Date().toISOString();
  await storage.updatePost(userId, req.params.id, {
    status: 'posted', postedAt: now, readyAt: null,
    lastResult: { ok: true, mode: 'manual', reason: 'Marked posted manually', completedAt: now }
  }, req.activeTikTokAccount.accountId,
  { event: 'marked_posted', detail: 'Marked posted manually by the operator; no API publish occurred.' });
  redirectWithNotice(res, 'Marked posted.');
}));

router.post('/posts/:id/pending', requireConnectedTikTokAccount, asyncRoute(async (req, res) => {
  const userId = resolveUserId(req);
  const post = await storage.getPost(userId, req.params.id, req.activeTikTokAccount.accountId);
  if (!post) { redirectWithNotice(res, 'Post not found.'); return; }
  await storage.updatePost(userId, req.params.id, {
    status: post.scheduledAt ? 'scheduled' : 'pending',
    postedAt: null,
    readyAt: null,
    errorMessage: null,
    lastResult: null,
    claimAttempts: 0,
    lockedAt: null,
    lockedBy: null
  }, req.activeTikTokAccount.accountId,
  { event: 'reset', detail: 'Returned to the queue by the operator; attempt counter cleared.' });
  redirectWithNotice(res, post.scheduledAt ? 'Back to schedule.' : 'Back to pending.');
}));

router.post('/posts/:id/delete', requireConnectedTikTokAccount, asyncRoute(async (req, res) => {
  const userId = resolveUserId(req);
  await storage.deletePost(userId, req.params.id, req.activeTikTokAccount.accountId);
  redirectWithNotice(res, 'Deleted.');
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function normalizeTargetChannelIds(value) {
  // Checkbox groups arrive as a string for one selection and an array for
  // several; normalize to a de-duplicated list of non-empty ids.
  const raw = Array.isArray(value) ? value : (value ? [value] : []);
  return [...new Set(raw.map((id) => String(id || '').trim()).filter(Boolean))];
}

function requireConnectedTikTokAccount(req, res, next) {
  if (!req.isAdmin) {
    requireAdminPage(req, res, next);
    return;
  }
  resolveTikTokAccountContext(req, res)
    .then(({ activeAccount }) => {
      if (!activeAccount || !activeAccount.connected) {
        redirectWithNotice(res, 'Select and connect a TikTok account before changing its queue.');
        return;
      }
      req.activeTikTokAccount = activeAccount;
      next();
    })
    .catch(next);
}

function getLoginAttempt(ip, now = Date.now()) {
  const key = String(ip || 'unknown');
  const attempt = loginAttempts.get(key);
  if (!attempt || now - attempt.startedAt >= LOGIN_WINDOW_MS) {
    loginAttempts.delete(key);
    return { locked: false, count: 0 };
  }
  return { locked: attempt.count >= LOGIN_MAX_ATTEMPTS, count: attempt.count };
}

function recordFailedLogin(ip, now = Date.now()) {
  const key = String(ip || 'unknown');
  const current = loginAttempts.get(key);
  if (!current || now - current.startedAt >= LOGIN_WINDOW_MS) {
    loginAttempts.set(key, { count: 1, startedAt: now });
    return;
  }
  current.count += 1;
}

async function resolveTikTokAccountContext(req, res) {
  const userId = resolveUserId(req);
  const accounts = await storage.getTikTokAccounts(userId);
  const selectedId = parseCookies(req.headers.cookie)[ACTIVE_TIKTOK_ACCOUNT_COOKIE] || '';
  const activeAccount = accounts.find((account) => account.accountId === selectedId)
    || accounts.find((account) => account.connected)
    || accounts[0]
    || null;

  if (activeAccount && activeAccount.accountId !== selectedId) {
    setActiveTikTokAccountCookie(res, activeAccount.accountId);
  }
  return { accounts, activeAccount };
}

function setActiveTikTokAccountCookie(res, accountId) {
  res.cookie(ACTIVE_TIKTOK_ACCOUNT_COOKIE, accountId, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 365 * 24 * 60 * 60 * 1000
  });
}

function publicTikTokAccount(account) {
  return {
    id: account.accountId,
    accountId: account.accountId,
    open_id: account.open_id,
    tiktokOpenId: account.open_id,
    platform: 'tiktok',
    username: account.username || '',
    displayName: account.displayName || '',
    avatarUrl: account.avatarUrl || '',
    connected: Boolean(account.connected),
    clientAccessEnabled: Boolean(account.clientAccessEnabled)
  };
}

function creatorInfoFromAccount(account) {
  if (!account) return null;
  return {
    creator_username: account.username || '',
    creator_nickname: account.displayName || '',
    creator_avatar_url: account.avatarUrl || '',
    privacy_level_options: []
  };
}

function accountLabel(account) {
  if (!account) return 'TikTok account';
  if (account.username) return `@${account.username}`;
  if (account.displayName) return account.displayName;
  return `TikTok ${String(account.accountId || '').slice(0, 8)}`;
}

function emptyPostCounts() {
  return { total: 0, pending: 0, scheduled: 0, processing: 0, ready: 0, posted: 0, failed: 0 };
}

function redirectWithNotice(res, notice) {
  res.redirect(`/private/autoposter?notice=${encodeURIComponent(notice)}`);
}

// Fast Schedule intake: the campaign form submits over XHR with
// `Accept: application/json` so the page can show inline progress and a
// result without discarding form state. Plain HTML form posts (the no-JS
// fallback) keep the redirect-with-notice behavior unchanged.
function respondWithNotice(req, res, notice, ok = true) {
  if (req.accepts(['html', 'json']) === 'json') {
    res.status(ok ? 200 : 400).json({ ok, notice });
    return;
  }
  redirectWithNotice(res, notice);
}

async function removeTemporaryUpload(filePath) {
  if (!filePath) return;
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('[auto-caption] could not remove temporary upload:', error.message);
    }
  }
}

function resolvePreparedMedia(token, userId, files) {
  if (!token) return null;
  for (const file of files) {
    try {
      const prepared = autoMusic.verifyPreparedMediaToken(token, { userId, file });
      if (prepared) return prepared;
    } catch (error) {
      console.warn('[auto-music] prepared media verification failed; using original upload', {
        code: error.code || 'PREPARED_MEDIA_INVALID'
      });
      return null;
    }
  }
  console.warn('[auto-music] prepared media token was invalid or expired; using original upload');
  return null;
}

async function runCronTick(req, res) {
  if (!authorizeCronRequest(req, res, 'cron')) return;
  const result = await scheduler.runSchedulerTick();
  res.status(result.ok ? 200 : 500).json(result);
}

function authorizeCronRequest(req, res, purpose) {
  if (!config.cronSecret) {
    res.status(503).json({ ok: false, reason: 'CRON_SECRET is not configured' });
    return false;
  }
  const suppliedSecret = req.get('x-cron-secret') || req.query.secret;
  if (suppliedSecret !== config.cronSecret) {
    res.status(403).json({ ok: false, reason: `Invalid ${purpose} secret` });
    return false;
  }
  return true;
}

function firstNonEmptyLine(value) {
  return String(value || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
}

async function getCreatorInfoSafe(accountId, userId) {
  try { return await tiktok.queryCreatorInfo(accountId, userId); }
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

function isPublicHttpsUrl(value) {
  try {
    return new URL(value).protocol === 'https:';
  } catch (error) {
    return false;
  }
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
// Unchanged from before: these all operate on plain post objects that have
// already been resolved (awaited) before rendering, so none of them need
// to be async themselves.

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
  if (getPostMediaType(post) === 'video') return post.mediaUrl || post.videoPath || post.mediaPath || post.publicMediaUrl || post.imagePath || '';
  return post.mediaUrl || post.imagePath || post.mediaPath || post.publicMediaUrl || post.publicImageUrl || '';
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
  let message = post && post.scheduledAt ? `Scheduled for ${viewHelpers.formatDateTime(post.scheduledAt)}.` : 'Ready to schedule.';

  // NOTE: the Firestore status value is "processing" now (was "publishing"
  // in the old file-based storage). tone/stateLabel are left as
  // "publishing" below on purpose — that string only drives the CSS class,
  // which the view already expects, so styling stays identical to before.
  if (status === 'processing') {
    stateLabel = 'Publishing'; tone = 'publishing';
    message = 'Posting to TikTok — this can take a moment for larger videos.';
  } else if (status === 'failed' || (lastResult && lastResult.ok === false && lastResult.mode !== 'manual')) {
    stateLabel = 'Failed'; tone = 'failed';
    const rawReason = (lastResult && lastResult.reason) || '';
    const fullJson = lastResult ? JSON.stringify(lastResult) : '';
    const isUnaudited = rawReason.includes('unaudited_client_can_only_post_to_private_accounts') || rawReason.includes('403') || fullJson.includes('unaudited_client_can_only_post_to_private_accounts');
    message = isUnaudited
      ? 'TikTok needs this account set to private until app review is complete.'
      : rawReason || "TikTok couldn't post this. Try again.";
  } else if (status === 'ready' || (lastResult && lastResult.mode === 'manual' && status !== 'posted')) {
    stateLabel = 'Needs manual verification'; tone = 'verification';
    message = (lastResult && lastResult.reason) || 'Check the media, then confirm it inside TikTok.';
  } else if (status === 'posted' && isApiAccepted) {
    stateLabel = shareUrl ? 'Posted verified' : 'API accepted';
    tone = shareUrl ? 'accepted' : 'verification';
    message = shareUrl
      ? 'TikTok confirmed this post is live.'
      : "TikTok accepted this post. Confirm it's live inside the app.";
  } else if (status === 'posted') {
    stateLabel = 'Posted manually'; tone = 'accepted';
    message = (lastResult && lastResult.reason) || 'Marked as posted.';
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
  const labels = { pending: 'Unscheduled', scheduled: 'Scheduled', processing: 'Publishing', ready: 'Needs manual verification', posted: 'Posted', failed: 'Failed' };
  const v = String(status || 'pending').toLowerCase();
  return labels[v] || `${v.charAt(0).toUpperCase()}${v.slice(1)}`;
}

async function saveInstagramAttempt(userId, postId, result) {
  if (!postId) return;
  const post = await storage.getPost(userId, postId);
  if (!post) return;
  await storage.updatePost(userId, postId, { lastInstagramResult: { ...result, completedAt: new Date().toISOString() } });
}

function instagramNotice(result) {
  if (result.code === 'INSTAGRAM_NOT_CONFIGURED') return result.message;
  if (result.ok && result.published) return 'Instagram accepted the publish request.';
  if (result.ok) return 'Instagram dry-run completed. No public publish was attempted.';
  if (result.mode === 'manual') return result.reason || 'Instagram needs a public media URL before testing.';
  return `Instagram attempt failed: ${result.reason || 'Unknown error'}`;
}

function wantsJson(req) {
  const accept = String(req.headers.accept || '').toLowerCase();
  const ct = String(req.headers['content-type'] || '').toLowerCase();
  return accept.includes('application/json') || ct.includes('application/json');
}

module.exports = router;
