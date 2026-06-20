const fs = require('fs');
const path = require('path');
const config = require('./config');
const storage = require('./storage');

const tokenRefreshBufferMs = 5 * 60 * 1000;
const videoInitUrl = 'https://open.tiktokapis.com/v2/post/publish/video/init/';
const creatorInfoQueryUrl = 'https://open.tiktokapis.com/v2/post/publish/creator_info/query/';

function requestSignal(timeoutMs = config.tiktok.requestTimeoutMs) {
  return AbortSignal.timeout(Math.max(1, Number(timeoutMs) || 30_000));
}

async function isConfigured() {
  return (await getTikTokAuthStatus()).connected;
}

function buildTikTokAuthUrl(state) {
  // Always ensure video.publish is included
  const scopeSet = new Set([
    'user.info.basic',
    'video.publish',
    ...String(config.tiktok.scopes || '').split(',').map(s => s.trim()).filter(Boolean)
  ]);

  const url = new URL(config.tiktok.authUrl);
  url.search = new URLSearchParams({
    client_key: config.tiktok.clientKey,
    response_type: 'code',
    scope: [...scopeSet].join(','),
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

async function getTikTokAuthStatus() {
  const auth = await storage.getTikTokAuth();
  return {
    connected: Boolean(auth.connected && auth.access_token),
    open_id: auth.open_id || '',
    expires_at: auth.expires_at || null,
    scope: auth.scope || ''
  };
}

async function refreshTikTokToken() {
  const auth = await storage.getTikTokAuth();
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

  const creatorInfo = await queryCreatorInfoForPublish(auth.access_token);

  if (isVideoPost(post)) {
    return publishVideoPost(post, auth.access_token, creatorInfo);
  }

  const imageUrl = getPublicImageUrl(post);
  if (!imageUrl) {
    return {
      ok: false,
      mode: 'manual',
      reason: 'Public image URL missing'
    };
  }

  const payload = buildPhotoPayload(post, imageUrl, creatorInfo);
  return postPhotoPayload(payload, auth.access_token);
}

function isVideoPost(post) {
  const mediaType = String(post.mediaType || '').toLowerCase();
  if (mediaType === 'video') return true;

  const fileName = String(post.fileName || post.mediaPath || post.videoPath || '').toLowerCase();
  return ['.mp4', '.mov', '.webm'].some((extension) => fileName.endsWith(extension));
}

async function publishVideoPost(post, accessToken, creatorInfo = null) {
  const source = await getVideoSource(post);
  if (!source.ok) return source;

  const fileSize = source.fileSize;
  const mimeType = getVideoMimeType(post);

  const payload = buildVideoPayload(post, fileSize, creatorInfo);
  const initResult = await postVideoInitPayload(payload, accessToken);

  if (!initResult.ok) {
    await cancelVideoSource(source);
    return initResult;
  }

  const uploadUrl = getUploadUrl(initResult.response);
  if (!uploadUrl) {
    await cancelVideoSource(source);
    return {
      ok: false,
      mode: 'api',
      reason: 'TikTok video init did not return upload_url',
      response: initResult.response
    };
  }

  const uploadResult = await uploadVideoFile(uploadUrl, source, fileSize, mimeType);
  await cancelVideoSource(source);
  if (!uploadResult.ok) return uploadResult;

  return {
    ok: true,
    mode: 'api',
    response: {
      init: initResult.response,
      upload: uploadResult.response
    }
  };
}

async function cancelVideoSource(source) {
  if (!source || !source.stream || typeof source.stream.cancel !== 'function') return;
  try {
    await source.stream.cancel();
  } catch (error) {
    // The upload may already own or have consumed the stream.
  }
}

async function getVideoSource(post) {
  const videoPath = getLocalMediaPath(post);

  if (videoPath) {
    try {
      const stats = fs.statSync(videoPath);
      if (stats.isFile() && stats.size > 0) {
        return { ok: true, source: 'local', videoPath, fileSize: stats.size };
      }
    } catch (error) {
      // Render restarts wipe local uploads. Fall through to the durable URL.
    }
  }

  const remoteUrl = getRemoteMediaUrl(post);
  if (!remoteUrl) {
    return {
      ok: false,
      mode: 'manual',
      reason: videoPath ? `Video file not found: ${path.basename(videoPath)}` : 'Video media URL missing'
    };
  }

  try {
    const response = await fetch(remoteUrl, { signal: requestSignal(config.tiktok.uploadTimeoutMs) });
    if (!response.ok) {
      return {
        ok: false,
        mode: 'api',
        reason: `Video media download returned HTTP ${response.status}`
      };
    }

    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > 0 && response.body) {
      return { ok: true, source: 'remote', stream: response.body, fileSize: contentLength };
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) {
      return {
        ok: false,
        mode: 'api',
        reason: 'Video file is empty'
      };
    }

    return { ok: true, source: 'remote', buffer, fileSize: buffer.length };
  } catch (error) {
    return {
      ok: false,
      mode: 'api',
      reason: `Could not load video media: ${error.message}`
    };
  }
}

async function queryCreatorInfo() {
  const auth = await getActiveTikTokAuth();
  if (!auth || !auth.access_token) {
    throw new Error('TikTok not connected');
  }

  return queryCreatorInfoWithToken(auth.access_token);
}

async function queryCreatorInfoForPublish(accessToken) {
  try {
    return await queryCreatorInfoWithToken(accessToken);
  } catch (error) {
    console.warn('[tiktok] creator info query failed', error.message);
    return null;
  }
}

async function queryCreatorInfoWithToken(accessToken) {
  const response = await fetch(creatorInfoQueryUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8'
    },
    body: JSON.stringify({}),
    signal: requestSignal()
  });

  const body = await parseResponseBody(response);

  if (!response.ok) {
    const error = new Error(`TikTok creator info returned HTTP ${response.status}`);
    error.response = body;
    throw error;
  }

  const apiError = getTikTokApiError(body);
  if (apiError) {
    const error = new Error(apiError);
    error.response = body;
    throw error;
  }

  return normalizeCreatorInfo(body);
}

function normalizeCreatorInfo(body) {
  const data = body && typeof body === 'object' && body.data && typeof body.data === 'object'
    ? body.data
    : body || {};

  const privacyLevelOptions = Array.isArray(data.privacy_level_options)
    ? data.privacy_level_options.map((option) => String(option || '').trim()).filter(Boolean)
    : [];

  return {
    creator_username: String(data.creator_username || '').trim(),
    creator_nickname: String(data.creator_nickname || '').trim(),
    creator_avatar_url: String(data.creator_avatar_url || '').trim(),
    privacy_level_options: privacyLevelOptions,
    comment_disabled: Boolean(data.comment_disabled),
    duet_disabled: Boolean(data.duet_disabled),
    stitch_disabled: Boolean(data.stitch_disabled),
    max_video_post_duration_sec: Number(data.max_video_post_duration_sec || 0) || 0
  };
}

function buildVideoPayload(post, fileSize, creatorInfo = null) {
  return {
    post_info: {
      title: buildCaption(post),
      privacy_level: resolvePrivacyLevel(post, creatorInfo),
      disable_duet:    Boolean(post.disableDuet),
      disable_comment: Boolean(post.disableComment),
      disable_stitch:  Boolean(post.disableStitch)
    },
    source_info: {
      source: 'FILE_UPLOAD',
      video_size: fileSize,
      chunk_size: fileSize,
      total_chunk_count: 1
    },
    post_mode: 'DIRECT_POST'
  };
}

async function postVideoInitPayload(payload, accessToken) {
  try {
    console.log('[tiktok] video init payload', JSON.stringify(payload, null, 2));

    const response = await fetch(videoInitUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8'
      },
      body: JSON.stringify(payload),
      signal: requestSignal()
    });

    const body = await parseResponseBody(response);

    if (!response.ok) {
      console.error('[tiktok] video init failed', JSON.stringify({
        status: response.status,
        body,
        payload
      }, null, 2));

      // HTTP 403 after approval = stale pre-approval token
      // User must Disconnect and reconnect TikTok to get fresh production token
      const reason = response.status === 403
        ? 'Token was issued before app approval. Please click Disconnect then reconnect TikTok to get a fresh production token.'
        : `TikTok video init returned HTTP ${response.status}`;

      return {
        ok: false,
        mode: 'api',
        reason,
        response: body
      };
    }

    const apiError = getTikTokApiError(body);
    if (apiError) {
      return {
        ok: false,
        mode: 'api',
        reason: apiError,
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

async function uploadVideoFile(uploadUrl, source, fileSize, mimeType) {
  try {
    const firstByte = 0;
    const lastByte = fileSize - 1;
    const uploadBody = source.stream || source.buffer || fs.createReadStream(source.videoPath);
    const requestOptions = {
      method: 'PUT',
      headers: {
        'Content-Type': mimeType,
        'Content-Length': String(fileSize),
        'Content-Range': `bytes ${firstByte}-${lastByte}/${fileSize}`
      },
      body: uploadBody,
      signal: requestSignal(config.tiktok.uploadTimeoutMs)
    };
    if (source.stream || source.videoPath) requestOptions.duplex = 'half';

    const response = await fetch(uploadUrl, requestOptions);

    const body = await parseResponseBody(response);

    if (!response.ok) {
      console.error('[tiktok] video upload failed', JSON.stringify({
        status: response.status,
        body
      }, null, 2));

      return {
        ok: false,
        mode: 'api',
        reason: `TikTok video upload returned HTTP ${response.status}`,
        response: body
      };
    }

    return {
      ok: true,
      mode: 'api',
      response: body || { uploaded: true, size: fileSize }
    };
  } catch (error) {
    return {
      ok: false,
      mode: 'api',
      reason: error.message
    };
  }
}

function getUploadUrl(response) {
  if (!response || typeof response !== 'object') return '';
  return response.upload_url || (response.data && response.data.upload_url) || '';
}

function getLocalMediaPath(post) {
  const fileName = String(post.fileName || '').trim();
  if (!fileName) return '';

  const uploadPath = path.resolve(config.uploadsDir, fileName);
  const uploadsRoot = path.resolve(config.uploadsDir);

  if (!uploadPath.startsWith(uploadsRoot)) return '';
  return uploadPath;
}

function getRemoteMediaUrl(post) {
  const candidates = [
    post.videoPath,
    post.mediaPath,
    post.publicMediaUrl,
    post.publicImageUrl
  ];

  return candidates.map((value) => String(value || '').trim()).find(isUsablePublicUrl) || '';
}

function getVideoMimeType(post) {
  const mimeType = String(post.mimeType || '').toLowerCase();
  if (['video/mp4', 'video/quicktime', 'video/webm'].includes(mimeType)) {
    return mimeType;
  }

  const fileName = String(post.fileName || '').toLowerCase();
  if (fileName.endsWith('.mov')) return 'video/quicktime';
  if (fileName.endsWith('.webm')) return 'video/webm';
  return 'video/mp4';
}

function buildPhotoPayload(post, imageUrl, creatorInfo = null) {
  return {
    post_info: {
      title: buildCaption(post),
      privacy_level: resolvePrivacyLevel(post, creatorInfo),
      disable_duet:    true,  // Not applicable for photo posts per TikTok guidelines
      disable_comment: Boolean(post.disableComment),
      disable_stitch:  true   // Not applicable for photo posts per TikTok guidelines
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

function resolvePrivacyLevel(post, creatorInfo = null) {
  const requested = String((post && post.privacyLevel) || config.tiktok.privacyLevel || 'SELF_ONLY').trim() || 'SELF_ONLY';
  const configured = String(config.tiktok.privacyLevel || 'SELF_ONLY').trim() || 'SELF_ONLY';
  const options = creatorInfo && Array.isArray(creatorInfo.privacy_level_options)
    ? creatorInfo.privacy_level_options.map((option) => String(option || '').trim()).filter(Boolean)
    : [];

  if (options.length === 0) return requested;
  if (options.includes(requested)) return requested;
  if (options.includes(configured)) return configured;
  if (options.includes('SELF_ONLY')) return 'SELF_ONLY';
  return options[0];
}

function getPublicImageUrl(post) {
  const publicUrl = [post.publicMediaUrl, post.publicImageUrl]
    .map((value) => String(value || '').trim())
    .find(isUsablePublicUrl);
  if (publicUrl) return publicUrl;

  const localImagePath = String(post.imageUrl || post.mediaPath || '').trim();
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
  const auth = await storage.getTikTokAuth();
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
    console.log('[tiktok] photo publish payload', JSON.stringify(payload, null, 2));

    const response = await fetch(config.tiktok.contentPostInitUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8'
      },
      body: JSON.stringify(payload),
      signal: requestSignal()
    });

    const body = await parseResponseBody(response);

    if (!response.ok) {
      console.error('[tiktok] photo content init failed', JSON.stringify({
        status: response.status,
        body,
        payload
      }, null, 2));

      const reason = response.status === 403
        ? 'Token was issued before app approval. Please click Disconnect then reconnect TikTok to get a fresh production token.'
        : `TikTok photo init returned HTTP ${response.status}`;

      return {
        ok: false,
        mode: 'api',
        reason,
        response: body
      };
    }

    const apiError = getTikTokApiError(body);
    if (apiError) {
      return {
        ok: false,
        mode: 'api',
        reason: apiError,
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
    body: new URLSearchParams(params).toString(),
    signal: requestSignal()
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

function getTikTokApiError(body) {
  if (!body || typeof body !== 'object') return '';

  const error = body.error;
  if (!error) return '';

  if (typeof error === 'string') {
    return error.toLowerCase() === 'ok' ? '' : error;
  }

  if (typeof error !== 'object') return '';

  const code = String(error.code || '').toLowerCase();
  if (!code || code === 'ok' || code === 'success') return '';

  return error.message || error.description || `TikTok API returned ${error.code}`;
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
  queryCreatorInfo,
  publishPhotoPost,
  buildCaption,
  buildPhotoPayload,
  buildVideoPayload,
  getPublicImageUrl,
  resolvePrivacyLevel
};
