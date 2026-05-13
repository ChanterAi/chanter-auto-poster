const config = require('./config');
const storage = require('./storage');

const tokenRefreshBufferMs = 5 * 60 * 1000;

function isConfigured() {
  return getTikTokAuthStatus().connected;
}

function buildTikTokAuthUrl(state) {
  const url = new URL(config.tiktok.authUrl);
  url.search = new URLSearchParams({
    client_key: config.tiktok.clientKey,
    response_type: 'code',
    scope: config.tiktok.scopes,
    redirect_uri: config.tiktok.redirectUri,
    state
  }).toString();

  return url.toString();
}

async function exchangeCodeForToken(code) {
  const body = await requestTikTokToken({
    client_key: config.tiktok.clientKey,
    client_secret: config.tiktok.clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: config.tiktok.redirectUri
  });

  return normalizeTokenResponse(body);
}

function getTikTokAuthStatus() {
  const auth = storage.getTikTokAuth();
  return {
    connected: Boolean(auth.connected && auth.access_token),
    open_id: auth.open_id || '',
    expires_at: auth.expires_at || null,
    scope: auth.scope || ''
  };
}

async function refreshTikTokToken() {
  const auth = storage.getTikTokAuth();
  if (!auth.connected || !auth.refresh_token) {
    return null;
  }

  const body = await requestTikTokToken({
    client_key: config.tiktok.clientKey,
    client_secret: config.tiktok.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: auth.refresh_token
  });

  return storage.saveTikTokAuth(normalizeTokenResponse(body, auth));
}

async function publishPhotoPost(post) {
  let auth;

  try {
    auth = await getActiveTikTokAuth();
  } catch (error) {
    return {
      ok: false,
      mode: 'api',
      reason: error.message,
      response: error.response || null
    };
  }

  if (!auth) {
    return {
      ok: false,
      mode: 'manual',
      reason: 'TikTok not connected'
    };
  }

  const imageUrl = getPublicImageUrl(post);
  if (!imageUrl) {
    return {
      ok: false,
      mode: 'manual',
      reason: 'Public image URL missing'
    };
  }

  const payload = buildPhotoPayload(post, imageUrl);
  return postPhotoPayload(payload, auth.access_token);
}

function buildPhotoPayload(post, imageUrl) {
  return {
    post_info: {
      title: buildCaption(post),
      privacy_level: config.tiktok.privacyLevel,
      disable_duet: false,
      disable_comment: false,
      disable_stitch: false
    },
    source_info: {
      source: 'PULL_FROM_URL',
      photo_cover_index: 0,
      photo_images: [imageUrl]
    },
    post_mode: 'DIRECT_POST',
    media_type: 'PHOTO'
  };
}

function getPublicImageUrl(post) {
  const publicImageUrl = String(post.publicImageUrl || '').trim();
  if (isUsablePublicUrl(publicImageUrl)) return publicImageUrl;

  const localImagePath = String(post.imageUrl || post.imagePath || '').trim();
  if (!config.publicBaseUrl || !localImagePath) return '';

  const fallbackUrl = `${config.publicBaseUrl}${localImagePath.startsWith('/') ? '' : '/'}${localImagePath}`;
  return isUsablePublicUrl(fallbackUrl) ? fallbackUrl : '';
}

function buildCaption(post) {
  return [post.caption, post.hashtags]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join('\n\n');
}

async function getActiveTikTokAuth() {
  const auth = storage.getTikTokAuth();
  if (!auth.connected || !auth.access_token) return null;
  if (!shouldRefresh(auth)) return auth;
  return refreshTikTokToken();
}

function shouldRefresh(auth) {
  if (!auth.expires_at) return false;
  const expiresAt = new Date(auth.expires_at).getTime();
  if (!Number.isFinite(expiresAt)) return false;
  return expiresAt - tokenRefreshBufferMs <= Date.now();
}

async function postPhotoPayload(payload, accessToken) {
  try {
    const response = await fetch(config.tiktok.contentPostInitUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8'
      },
      body: JSON.stringify(payload)
    });

    const body = await parseResponseBody(response);

    if (!response.ok) {
      console.error('[tiktok] content init failed', {
        status: response.status,
        body,
        payload
      });

      return {
        ok: false,
        mode: 'api',
        reason: `TikTok API returned HTTP ${response.status}`,
        response: body
      };
    }

    return {
      ok: true,
      mode: 'api',
      response: body
    };
  } catch (error) {
    return {
      ok: false,
      mode: 'api',
      reason: error.message
    };
  }
}

async function requestTikTokToken(params) {
  if (!config.tiktok.clientKey || !config.tiktok.clientSecret) {
    throw new Error('TikTok client key and secret are required');
  }

  const response = await fetch(config.tiktok.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cache-Control': 'no-cache'
    },
    body: new URLSearchParams(params).toString()
  });

  const body = await parseResponseBody(response);

  if (!response.ok || (body && body.error)) {
    const error = new Error(getTikTokErrorMessage(body, `TikTok OAuth returned HTTP ${response.status}`));
    error.response = body;
    throw error;
  }

  return body || {};
}

function normalizeTokenResponse(body, previous = {}) {
  const expiresIn = Number(body.expires_in || 0);
  const expiresAt = expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000).toISOString() : null;

  return {
    connected: Boolean(body.access_token || previous.access_token),
    open_id: body.open_id || previous.open_id || '',
    access_token: body.access_token || previous.access_token || '',
    refresh_token: body.refresh_token || previous.refresh_token || '',
    expires_at: expiresAt,
    scope: body.scope || previous.scope || ''
  };
}

function getTikTokErrorMessage(body, fallback) {
  if (!body || typeof body !== 'object') return fallback;
  return body.error_description || body.message || body.error || fallback;
}

function isUsablePublicUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !isLocalHost(url.hostname);
  } catch (error) {
    return false;
  }
}

function isLocalHost(hostname) {
  const value = String(hostname || '').toLowerCase();
  return value === 'localhost' || value === '::1' || value.startsWith('127.');
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

module.exports = {
  isConfigured,
  buildTikTokAuthUrl,
  exchangeCodeForToken,
  getTikTokAuthStatus,
  refreshTikTokToken,
  publishPhotoPost,
  buildCaption,
  buildPhotoPayload,
  getPublicImageUrl
};
