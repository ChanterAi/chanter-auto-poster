const config = require('./config');
const storage = require('./storage');

const tokenRefreshBufferMs = 5 * 60 * 1000;
const defaultStatusPollAttempts = Number(process.env.INSTAGRAM_STATUS_POLL_ATTEMPTS || 5);
const defaultStatusPollIntervalMs = Number(process.env.INSTAGRAM_STATUS_POLL_INTERVAL_MS || 3000);

function hasOAuthConfig() {
  return Boolean(config.instagram.appId && config.instagram.appSecret && config.instagram.redirectUri);
}

function buildInstagramAuthUrl(state) {
  const url = new URL(config.instagram.authUrl);
  url.search = new URLSearchParams({
    client_id: config.instagram.appId,
    redirect_uri: config.instagram.redirectUri,
    response_type: 'code',
    scope: config.instagram.scopes,
    state
  }).toString();

  return url.toString();
}

async function exchangeCodeForToken(code) {
  if (!hasOAuthConfig()) {
    throw new Error('Meta app ID, app secret, and redirect URI are required');
  }

  logApiStep('oauth.exchange_code.start', {
    redirectUri: config.instagram.redirectUri,
    scopes: config.instagram.scopes
  });

  const shortLivedToken = await graphRequest('oauth/access_token', {
    step: 'oauth.exchange_code',
    params: {
      client_id: config.instagram.appId,
      client_secret: config.instagram.appSecret,
      redirect_uri: config.instagram.redirectUri,
      code
    }
  });

  const longLivedToken = await exchangeForLongLivedToken(shortLivedToken.access_token);
  const token = normalizeTokenResponse(longLivedToken || shortLivedToken, {
    source: longLivedToken ? 'oauth_long_lived' : 'oauth_short_lived',
    scope: shortLivedToken.scope || config.instagram.scopes
  });
  const account = await discoverInstagramAccount(token.access_token);

  return {
    ...token,
    ...account,
    connected: true
  };
}

async function exchangeForLongLivedToken(accessToken) {
  if (!accessToken) return null;

  try {
    logApiStep('oauth.long_lived.start', {});

    return await graphRequest('oauth/access_token', {
      step: 'oauth.long_lived',
      params: {
        grant_type: 'fb_exchange_token',
        client_id: config.instagram.appId,
        client_secret: config.instagram.appSecret,
        fb_exchange_token: accessToken
      }
    });
  } catch (error) {
    console.warn('[instagram] oauth.long_lived skipped', error.message);
    return null;
  }
}

async function discoverInstagramAccount(accessToken) {
  const configuredInstagramId = String(config.instagram.instagramBusinessAccountId || '').trim();

  if (configuredInstagramId) {
    const profile = await queryInstagramProfileSafe(configuredInstagramId, accessToken);
    return {
      instagram_business_account_id: configuredInstagramId,
      instagram_username: profile.username || '',
      account_type: profile.account_type || '',
      profile_picture_url: profile.profile_picture_url || '',
      media_count: numberOrNull(profile.media_count),
      followers_count: numberOrNull(profile.followers_count),
      facebook_page_id: config.instagram.facebookPageId || '',
      source: 'oauth_configured_account'
    };
  }

  logApiStep('account.discover_pages.start', {
    preferredPageId: config.instagram.facebookPageId || ''
  });

  const pages = await graphRequest('me/accounts', {
    step: 'account.discover_pages',
    params: {
      fields:
        'id,name,access_token,instagram_business_account{id,username,profile_picture_url,account_type,media_count,followers_count}',
      limit: 100,
      access_token: accessToken
    }
  });

  const pageList = Array.isArray(pages && pages.data) ? pages.data : [];
  const preferredPageId = String(config.instagram.facebookPageId || '').trim();
  const page = pageList.find((item) => {
    if (!item || !item.instagram_business_account) return false;
    return preferredPageId ? String(item.id) === preferredPageId : true;
  });

  if (!page) {
    throw new Error(
      preferredPageId
        ? 'Connected Facebook Page did not expose an Instagram professional account.'
        : 'No Facebook Page with a connected Instagram professional account was found.'
    );
  }

  const instagramAccount = page.instagram_business_account || {};

  logApiStep('account.discover_pages.selected', {
    facebookPageId: page.id,
    facebookPageName: page.name,
    instagramBusinessAccountId: instagramAccount.id,
    instagramUsername: instagramAccount.username || ''
  });

  return {
    facebook_page_id: page.id || '',
    facebook_page_name: page.name || '',
    facebook_page_access_token: page.access_token || '',
    instagram_business_account_id: instagramAccount.id || '',
    instagram_username: instagramAccount.username || '',
    account_type: instagramAccount.account_type || '',
    profile_picture_url: instagramAccount.profile_picture_url || '',
    media_count: numberOrNull(instagramAccount.media_count),
    followers_count: numberOrNull(instagramAccount.followers_count),
    source: 'oauth_discovered_page'
  };
}

async function queryInstagramProfileSafe(instagramAccountId, accessToken) {
  try {
    return await graphRequest(instagramAccountId, {
      step: 'account.profile',
      params: {
        fields: 'id,username,profile_picture_url,account_type,media_count,followers_count',
        access_token: accessToken
      }
    });
  } catch (error) {
    console.warn('[instagram] account.profile unavailable', error.message);
    return {};
  }
}

async function getInstagramAuth() {
  const stored = await storage.getInstagramAuth();
  const accessToken = stored.access_token || config.instagram.accessToken;
  const instagramBusinessAccountId =
    stored.instagram_business_account_id || config.instagram.instagramBusinessAccountId;
  const facebookPageId = stored.facebook_page_id || config.instagram.facebookPageId;
  const source = stored.source || (accessToken ? 'env' : '');

  return {
    ...stored,
    source,
    access_token: accessToken,
    instagram_business_account_id: instagramBusinessAccountId,
    facebook_page_id: facebookPageId,
    connected: Boolean(accessToken)
  };
}

async function getInstagramAuthStatus() {
  const auth = await getInstagramAuth();
  const connected = Boolean(auth.access_token);
  const tokenExpired = connected && isTokenExpired(auth);
  const hasProfessionalAccount = Boolean(auth.instagram_business_account_id);
  const readyToPublish = connected && !tokenExpired && hasProfessionalAccount;

  let state = 'not_connected';
  let label = 'Not connected';

  if (tokenExpired) {
    state = 'token_expired';
    label = 'Token expired';
  } else if (readyToPublish) {
    state = 'ready';
    label = 'Ready to publish';
  } else if (connected) {
    state = 'connected';
    label = 'Connected';
  }

  return {
    configured: hasOAuthConfig() || Boolean(config.instagram.accessToken),
    connected,
    tokenExpired,
    readyToPublish,
    state,
    label,
    testMode: config.instagram.testMode,
    publishEnabled: config.instagram.publishEnabled,
    canPublishPublicly: readyToPublish && config.instagram.publishEnabled && !config.instagram.testMode,
    expires_at: auth.expires_at || null,
    scope: auth.scope || config.instagram.scopes || '',
    source: auth.source || '',
    facebook_page_id: auth.facebook_page_id || '',
    facebook_page_name: auth.facebook_page_name || '',
    instagram_business_account_id: auth.instagram_business_account_id || '',
    instagram_username: auth.instagram_username || '',
    account_type: auth.account_type || ''
  };
}

async function publishInstagramMedia(input = {}) {
  const auth = await getActiveInstagramAuth();
  const post = input.post || (input.postId ? await storage.getPost(input.userId, input.postId) : null);

  if (input.postId && !post) {
    return {
      ok: false,
      mode: 'api',
      published: false,
      reason: 'Post not found'
    };
  }

  const publishKind = resolvePublishKind(input, post);
  const mediaUrl = resolvePublicMediaUrl(input, post, publishKind);

  if (!isUsablePublicUrl(mediaUrl)) {
    return {
      ok: false,
      mode: 'manual',
      published: false,
      reason: 'Instagram requires a public HTTPS media URL before a container can be created.',
      response: {
        publishKind,
        mediaUrl: mediaUrl || ''
      }
    };
  }

  const payload = buildContainerPayload({
    publishKind,
    mediaUrl,
    caption: resolveCaption(input, post),
    altText: String(input.altText || '').trim(),
    shareToFeed: parseBoolean(input.shareToFeed, true),
    isCarouselItem: parseBoolean(input.isCarouselItem, false)
  });

  const container = await graphRequest(`${auth.instagram_business_account_id}/media`, {
    method: 'POST',
    step: 'media.create_container',
    params: {
      ...payload,
      access_token: auth.access_token
    }
  });

  const containerId = container && container.id ? String(container.id) : '';
  if (!containerId) {
    return {
      ok: false,
      mode: 'api',
      published: false,
      reason: 'Instagram did not return a media container ID.',
      response: container
    };
  }

  let containerStatus = null;
  if (publishKind !== 'photo') {
    containerStatus = await waitForContainerProcessing(containerId, auth.access_token);
  }

  const shouldPublish = shouldPublishPublicly(input);
  if (!shouldPublish) {
    logApiStep('media.publish.skipped', {
      containerId,
      testMode: config.instagram.testMode,
      publishEnabled: config.instagram.publishEnabled,
      dryRun: parseBoolean(input.dryRun, false)
    });

    return {
      ok: true,
      mode: 'test',
      published: false,
      reason: 'Instagram test mode created a media container. Public media_publish was skipped.',
      response: {
        container,
        containerStatus,
        payload: sanitizeParams(payload),
        publishSkipped: true
      }
    };
  }

  if (containerStatus && !isFinishedStatus(containerStatus.status_code)) {
    return {
      ok: false,
      mode: 'api',
      published: false,
      reason: `Instagram container is not ready: ${containerStatus.status_code || 'unknown'}`,
      response: {
        container,
        containerStatus
      }
    };
  }

  const publish = await graphRequest(`${auth.instagram_business_account_id}/media_publish`, {
    method: 'POST',
    step: 'media.publish_container',
    params: {
      creation_id: containerId,
      access_token: auth.access_token
    }
  });

  return {
    ok: true,
    mode: 'api',
    published: true,
    reason: 'Instagram accepted the publish request.',
    response: {
      container,
      containerStatus,
      publish
    }
  };
}

async function getContainerStatus(containerId) {
  const auth = await getActiveInstagramAuth();
  return queryContainerStatus(containerId, auth.access_token);
}

async function queryContainerStatus(containerId, accessToken) {
  if (!containerId) {
    throw new Error('Instagram container ID is required');
  }

  return graphRequest(containerId, {
    step: 'media.container_status',
    params: {
      fields: 'id,status,status_code',
      access_token: accessToken
    }
  });
}

async function waitForContainerProcessing(containerId, accessToken) {
  const attempts = Math.max(1, defaultStatusPollAttempts || 1);
  const intervalMs = Math.max(250, defaultStatusPollIntervalMs || 3000);
  let latestStatus = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    latestStatus = await queryContainerStatus(containerId, accessToken);
    const statusCode = String(latestStatus.status_code || '').toUpperCase();

    if (isFinishedStatus(statusCode) || statusCode === 'ERROR' || statusCode === 'EXPIRED') {
      return latestStatus;
    }

    if (attempt < attempts) {
      await delay(intervalMs);
    }
  }

  return latestStatus;
}

async function getActiveInstagramAuth() {
  const auth = await getInstagramAuth();

  if (!auth.access_token) {
    throw new Error('Instagram not connected');
  }

  if (isTokenExpired(auth)) {
    throw new Error('Instagram token expired. Reconnect Instagram.');
  }

  if (!auth.instagram_business_account_id) {
    throw new Error('Instagram connected, but no professional account ID is available.');
  }

  return auth;
}

function buildContainerPayload({ publishKind, mediaUrl, caption, altText, shareToFeed, isCarouselItem }) {
  const payload = {};
  const cleanCaption = String(caption || '').trim();

  if (cleanCaption) {
    payload.caption = cleanCaption.slice(0, 2200);
  }

  if (publishKind === 'photo') {
    payload.image_url = mediaUrl;

    if (altText) {
      payload.alt_text = altText.slice(0, 1000);
    }
  } else if (publishKind === 'story') {
    payload.media_type = 'STORIES';

    if (isVideoUrl(mediaUrl)) {
      payload.video_url = mediaUrl;
    } else {
      payload.image_url = mediaUrl;
    }
  } else {
    payload.media_type = 'REELS';
    payload.video_url = mediaUrl;
    payload.share_to_feed = shareToFeed ? 'true' : 'false';
  }

  if (isCarouselItem && publishKind !== 'reel' && publishKind !== 'story') {
    payload.is_carousel_item = 'true';
  }

  return payload;
}

function resolvePublishKind(input, post) {
  const requested = String(input.publishType || input.instagramPublishType || input.mediaType || '')
    .trim()
    .toLowerCase();

  if (['image', 'photo', 'feed_image'].includes(requested)) return 'photo';
  if (['story', 'stories'].includes(requested)) return 'story';
  if (['video', 'reel', 'reels'].includes(requested)) return 'reel';
  return isVideoPost(post) ? 'reel' : 'photo';
}

function resolvePublicMediaUrl(input, post, publishKind) {
  const directUrl = String(input.mediaUrl || input.imageUrl || input.videoUrl || '').trim();
  if (directUrl) return directUrl;

  if (post) {
    const instagramUrl = String(post.instagramMediaUrl || '').trim();
    if (instagramUrl) return instagramUrl;

    const mediaUrl = String(post.mediaUrl || '').trim();
    if (mediaUrl) return mediaUrl;

    const publicMediaUrl = String(post.publicMediaUrl || '').trim();
    if (publicMediaUrl) return publicMediaUrl;

    const publicImageUrl = String(post.publicImageUrl || '').trim();
    if (publishKind === 'photo' && publicImageUrl) return publicImageUrl;

    const mediaPath = String(post.mediaPath || post.imagePath || post.videoPath || '').trim();
    if (config.publicBaseUrl && mediaPath) {
      return `${config.publicBaseUrl}${mediaPath.startsWith('/') ? '' : '/'}${mediaPath}`;
    }
  }

  return '';
}

function resolveCaption(input, post) {
  const directCaption = String(input.caption || '').trim();
  if (directCaption) return directCaption;
  return buildCaption(post || {});
}

function buildCaption(post) {
  return [post.caption, post.hashtags]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join('\n\n');
}

function shouldPublishPublicly(input) {
  if (parseBoolean(input.dryRun, false)) return false;
  return Boolean(config.instagram.publishEnabled && !config.instagram.testMode);
}

function normalizeTokenResponse(body, extra = {}) {
  const expiresIn = Number(body && body.expires_in ? body.expires_in : 0);
  const expiresAt = expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000).toISOString() : null;

  return {
    connected: Boolean(body && body.access_token),
    source: extra.source || '',
    user_id: (body && (body.user_id || body.id)) || '',
    access_token: (body && body.access_token) || '',
    token_type: (body && body.token_type) || '',
    expires_at: expiresAt,
    scope: (body && body.scope) || extra.scope || ''
  };
}

async function graphRequest(path, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const params = options.params || {};
  const url = buildGraphUrl(path);
  const requestInit = { method };

  if (method === 'GET') {
    appendParams(url.searchParams, params);
  } else {
    requestInit.headers = {
      'Content-Type': 'application/x-www-form-urlencoded'
    };
    requestInit.body = toSearchParams(params).toString();
  }

  logApiStep(`${options.step || 'graph.request'}.request`, {
    method,
    url: redactUrl(url),
    params: sanitizeParams(params)
  });

  const response = await fetch(url, requestInit);
  const body = await parseResponseBody(response);

  logApiStep(`${options.step || 'graph.request'}.response`, {
    status: response.status,
    ok: response.ok,
    body: sanitizeResponse(body)
  });

  if (!response.ok || (body && body.error)) {
    const error = new Error(getGraphErrorMessage(body, `Instagram Graph API returned HTTP ${response.status}`));
    error.response = body;
    throw error;
  }

  return body || {};
}

function buildGraphUrl(path) {
  const cleanPath = String(path || '').replace(/^\/+/, '');
  return new URL(`${config.instagram.graphBaseUrl}/${config.instagram.graphVersion}/${cleanPath}`);
}

function appendParams(searchParams, params) {
  const built = toSearchParams(params);
  built.forEach((value, key) => {
    searchParams.append(key, value);
  });
}

function toSearchParams(params) {
  const searchParams = new URLSearchParams();

  Object.entries(params || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    searchParams.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
  });

  return searchParams;
}

async function parseResponseBody(response) {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch (error) {
    return text;
  }
}

function getGraphErrorMessage(body, fallback) {
  if (!body || typeof body !== 'object') return fallback;
  const error = body.error;
  if (!error) return body.message || fallback;
  if (typeof error === 'string') return error;
  return error.error_user_msg || error.message || error.error_subcode || error.code || fallback;
}

function isTokenExpired(auth) {
  if (!auth || !auth.expires_at) return false;
  const expiresAt = new Date(auth.expires_at).getTime();
  if (!Number.isFinite(expiresAt)) return false;
  return expiresAt - tokenRefreshBufferMs <= Date.now();
}

function isUsablePublicUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'https:' && !isLocalHost(url.hostname);
  } catch (error) {
    return false;
  }
}

function isLocalHost(hostname) {
  const value = String(hostname || '').toLowerCase();
  return value === 'localhost' || value === '::1' || value.startsWith('127.');
}

function isVideoPost(post) {
  if (!post) return false;
  const mediaType = String(post.mediaType || '').toLowerCase();
  if (mediaType === 'video') return true;

  const fileName = String(post.fileName || post.mediaPath || post.videoPath || '').toLowerCase();
  return ['.mp4', '.mov', '.webm'].some((extension) => fileName.endsWith(extension));
}

function isVideoUrl(value) {
  const path = (() => {
    try {
      return new URL(String(value || '')).pathname.toLowerCase();
    } catch (error) {
      return String(value || '').toLowerCase();
    }
  })();

  return ['.mp4', '.mov', '.webm'].some((extension) => path.endsWith(extension));
}

function isFinishedStatus(statusCode) {
  return String(statusCode || '').toUpperCase() === 'FINISHED';
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function logApiStep(step, details) {
  console.log(`[instagram] ${step}`, JSON.stringify(details || {}, null, 2));
}

function redactUrl(url) {
  const safeUrl = new URL(url.toString());
  ['access_token', 'client_secret', 'code', 'fb_exchange_token'].forEach((key) => {
    if (safeUrl.searchParams.has(key)) {
      safeUrl.searchParams.set(key, maskToken(safeUrl.searchParams.get(key)));
    }
  });
  return safeUrl.toString();
}

function sanitizeParams(params) {
  if (!params || typeof params !== 'object') return params;

  return Object.entries(params).reduce((safe, [key, value]) => {
    const normalizedKey = key.toLowerCase();
    if (
      normalizedKey.includes('token') ||
      normalizedKey.includes('secret') ||
      normalizedKey === 'code'
    ) {
      safe[key] = maskToken(value);
    } else {
      safe[key] = value;
    }
    return safe;
  }, {});
}

function sanitizeResponse(value) {
  if (!value || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeResponse(item));
  }

  return Object.entries(value).reduce((safe, [key, nestedValue]) => {
    const normalizedKey = key.toLowerCase();
    if (normalizedKey.includes('token') || normalizedKey.includes('secret')) {
      safe[key] = maskToken(nestedValue);
    } else if (nestedValue && typeof nestedValue === 'object') {
      safe[key] = sanitizeResponse(nestedValue);
    } else {
      safe[key] = nestedValue;
    }
    return safe;
  }, {});
}

function maskToken(value) {
  const raw = String(value || '');
  if (!raw) return '';
  if (raw.length <= 8) return '***';
  return `${raw.slice(0, 4)}...${raw.slice(-4)}`;
}

module.exports = {
  hasOAuthConfig,
  buildInstagramAuthUrl,
  exchangeCodeForToken,
  getInstagramAuth,
  getInstagramAuthStatus,
  publishInstagramMedia,
  getContainerStatus,
  buildCaption
};
