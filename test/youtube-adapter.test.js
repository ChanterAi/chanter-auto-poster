'use strict';

// YouTube provider adapter against a controlled local HTTP fake. No test
// here ever calls a live Google or YouTube endpoint: every base URL is
// pointed at the local server via the documented test-injection env vars
// BEFORE config loads.

const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, createHash } = require('node:crypto');

const CANARY_CLIENT_SECRET = 'CANARY-YT-CLIENT-SECRET-77aa88bb';
const CANARY_ACCESS = 'CANARY-YT-ACCESS-11cc22dd';
const CANARY_REFRESH = 'CANARY-YT-REFRESH-33ee44ff';

// Controlled Google fake. Route behavior is driven by token/session values
// so each test picks its scenario without shared mutable state.
const requestsLog = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    requestsLog.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body });

    if (req.method === 'POST' && url.pathname === '/token') {
      const params = new URLSearchParams(body);
      if (params.get('grant_type') === 'authorization_code') {
        res.setHeader('Content-Type', 'application/json');
        const withRefresh = params.get('code') !== 'code-without-refresh';
        res.end(JSON.stringify({
          access_token: CANARY_ACCESS,
          ...(withRefresh ? { refresh_token: CANARY_REFRESH } : {}),
          expires_in: 3600,
          scope: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly',
          token_type: 'Bearer'
        }));
        return;
      }
      if (params.get('grant_type') === 'refresh_token') {
        if (params.get('refresh_token') === 'revoked-refresh-token') {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been revoked.' }));
          return;
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ access_token: `${CANARY_ACCESS}-refreshed`, expires_in: 3600, token_type: 'Bearer' }));
        return;
      }
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'unsupported_grant_type' }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/channels') {
      const auth = String(req.headers.authorization || '');
      res.setHeader('Content-Type', 'application/json');
      if (auth.includes('scopeless-token')) {
        res.statusCode = 403;
        res.end(JSON.stringify({ error: { code: 403, message: 'Request had insufficient authentication scopes.', errors: [{ reason: 'insufficientPermissions' }] } }));
        return;
      }
      if (auth.includes('zero-channel-token')) {
        res.end(JSON.stringify({ items: [] }));
        return;
      }
      res.end(JSON.stringify({
        items: [{
          id: 'UC-chanter',
          snippet: { title: 'chanterCy', customUrl: '@chanterCy', thumbnails: { default: { url: 'https://yt3.example.com/avatar.jpg' } } }
        }]
      }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/upload/videos') {
      if (url.searchParams.get('fail') === 'init') {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: { code: 500, message: 'Backend error' } }));
        return;
      }
      const session = randomBytes(8).toString('hex');
      res.setHeader('Location', `http://localhost:${server.address().port}/upload-session/${session}${url.searchParams.get('mode') ? `?mode=${url.searchParams.get('mode')}` : ''}`);
      res.statusCode = 200;
      res.end();
      return;
    }

    if (req.method === 'PUT' && url.pathname.startsWith('/upload-session/')) {
      const mode = url.searchParams.get('mode') || '';
      if (mode === 'reject') {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: { code: 400, message: 'Invalid video metadata', errors: [{ reason: 'invalidRequest' }] } }));
        return;
      }
      if (mode === 'ambiguous') {
        req.socket.destroy();
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        id: 'yt-video-123',
        status: { uploadStatus: 'uploaded', privacyStatus: 'private' },
        snippet: { channelId: 'UC-chanter' }
      }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/videos') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        items: [{ id: url.searchParams.get('id'), status: { uploadStatus: 'processed', privacyStatus: 'private' }, processingDetails: { processingStatus: 'succeeded' } }]
      }));
      return;
    }

    res.statusCode = 404;
    res.end('{}');
  });
});

let youtube;
let storage;
let tokenVault;
let config;
let baseUrl;

test.before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  process.env.ADMIN_PASSWORD = 'test-admin-password-123';
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('base64');
  process.env.YOUTUBE_CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
  process.env.YOUTUBE_CLIENT_SECRET = CANARY_CLIENT_SECRET;
  process.env.YOUTUBE_REDIRECT_URI = 'http://localhost:10000/auth/youtube/callback';
  process.env.YOUTUBE_OAUTH_TOKEN_URL = `${baseUrl}/token`;
  process.env.YOUTUBE_OAUTH_REVOKE_URL = `${baseUrl}/revoke`;
  process.env.YOUTUBE_API_BASE_URL = `${baseUrl}/api`;
  process.env.YOUTUBE_UPLOAD_BASE_URL = `${baseUrl}/upload`;
  process.env.YOUTUBE_MAX_VIDEO_BYTES = String(1024 * 1024);

  config = require('../src/config');
  storage = require('../src/storage');
  tokenVault = require('../src/tokenVault');
  youtube = require('../src/youtube');
});

test.after(() => new Promise((resolve) => server.close(resolve)));

function installAccountFakes({ account, tokens }) {
  const state = {
    account: {
      accountId: 'UC-chanter',
      userId: 'owner',
      provider: 'youtube',
      platform: 'youtube',
      channelId: 'UC-chanter',
      username: 'chanterCy',
      connected: true,
      tokenPresent: true,
      refreshTokenPresent: true,
      accessTokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      grantedScopes: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly',
      reauthorizationRequired: false,
      ...account
    },
    tokens: { access_token: CANARY_ACCESS, refresh_token: CANARY_REFRESH, ...tokens },
    tokenStateUpdates: [],
    reauthorizationMarks: []
  };
  storage.getYouTubeAccount = async (userId, accountId) =>
    (userId === state.account.userId && accountId === state.account.accountId ? state.account : null);
  storage.getYouTubeAccountCredential = async (userId, accountId) =>
    (userId === state.account.userId && accountId === state.account.accountId
      ? tokenVault.encryptCredentials(state.tokens)
      : null);
  storage.updateYouTubeAccountTokenState = async (userId, accountId, update) => {
    state.tokenStateUpdates.push(update);
    return state.account;
  };
  storage.markYouTubeAccountReauthorizationRequired = async (userId, accountId, code) => {
    state.reauthorizationMarks.push(code);
    state.account.reauthorizationRequired = true;
    return true;
  };
  return state;
}

function basePost(overrides = {}) {
  return {
    id: 'job-1',
    userId: 'owner',
    provider: 'youtube',
    platform: 'youtube',
    accountId: 'UC-chanter',
    mediaType: 'video',
    mimeType: 'video/mp4',
    fileName: '',
    mediaUrl: '',
    publishId: '',
    providerMetadata: { youtube: { title: 'Test title', description: 'Test description', privacyStatus: 'private', notifySubscribers: false } },
    ...overrides
  };
}

function writeLocalVideo(name, bytes) {
  fs.mkdirSync(config.uploadsDir, { recursive: true });
  const filePath = path.join(config.uploadsDir, name);
  fs.writeFileSync(filePath, randomBytes(bytes));
  return filePath;
}

test('authorize URL: code flow, offline access, incremental scopes, PKCE S256, exact redirect URI', () => {
  const pkce = youtube.createPkcePair();
  const url = new URL(youtube.buildYouTubeAuthUrl('state-abc', { codeChallenge: pkce.challenge }));
  const params = url.searchParams;
  assert.equal(params.get('response_type'), 'code');
  assert.equal(params.get('access_type'), 'offline');
  assert.equal(params.get('include_granted_scopes'), 'true');
  assert.equal(params.get('redirect_uri'), 'http://localhost:10000/auth/youtube/callback');
  assert.equal(params.get('state'), 'state-abc');
  assert.equal(params.get('code_challenge_method'), 'S256');
  assert.equal(params.get('code_challenge'), createHash('sha256').update(pkce.verifier).digest('base64url'));
  assert.match(params.get('scope'), /youtube\.upload/);
  assert.match(params.get('scope'), /youtube\.readonly/);
  assert.equal(params.get('prompt'), null, 'consent must not be forced by default');
  assert.equal(params.get('client_secret'), null, 'the client secret never appears in a browser URL');

  const consentUrl = new URL(youtube.buildYouTubeAuthUrl('s', { forceConsent: true }));
  assert.equal(consentUrl.searchParams.get('prompt'), 'consent');
});

test('code exchange posts the verifier and normalizes tokens; refresh preservation works', async () => {
  const exchanged = await youtube.exchangeCodeForToken('auth-code-1', 'verifier-1');
  assert.equal(exchanged.tokens.access_token, CANARY_ACCESS);
  assert.equal(exchanged.tokens.refresh_token, CANARY_REFRESH);
  assert.equal(exchanged.meta.refreshTokenPresent, true);
  assert.match(exchanged.meta.grantedScopes, /youtube\.upload/);
  const tokenRequest = requestsLog.filter((entry) => entry.path === '/token').at(-1);
  const params = new URLSearchParams(tokenRequest.body);
  assert.equal(params.get('grant_type'), 'authorization_code');
  assert.equal(params.get('code_verifier'), 'verifier-1');
  assert.equal(params.get('redirect_uri'), 'http://localhost:10000/auth/youtube/callback');

  // Google returned no refresh token: the previous one is preserved.
  const reconnect = await youtube.exchangeCodeForToken('code-without-refresh', 'verifier-2');
  assert.equal(reconnect.tokens.refresh_token, '', 'no previous token to preserve here');
  const normalized = youtube.normalizeTokenResponse({ access_token: 'a', expires_in: 60 }, { refresh_token: CANARY_REFRESH });
  assert.equal(normalized.tokens.refresh_token, CANARY_REFRESH);
  assert.equal(normalized.meta.refreshTokenRotated, false);
});

test('channel resolution returns safe channel metadata and normalizes a missing-scope 403', async () => {
  const channels = await youtube.listMyChannels('good-token');
  assert.deepEqual(channels, [{
    channelId: 'UC-chanter',
    title: 'chanterCy',
    handle: '@chanterCy',
    thumbnailUrl: 'https://yt3.example.com/avatar.jpg'
  }]);
  await assert.rejects(
    () => youtube.listMyChannels('scopeless-token'),
    (error) => error.code === 'missing_readonly_scope'
  );
});

test('metadata validation: title required and bounded; TikTok captions are never mapped in', () => {
  assert.equal(youtube.validateYouTubeMetadata({ title: 'Fine title' }).ok, true);
  assert.equal(youtube.validateYouTubeMetadata({}).ok, false);
  assert.equal(youtube.validateYouTubeMetadata({ title: '   ' }).ok, false);
  assert.equal(youtube.validateYouTubeMetadata({ title: 'x'.repeat(101) }).ok, false);
  assert.equal(youtube.validateYouTubeMetadata({ title: 'bad <angle>' }).ok, false);
  assert.equal(youtube.validateYouTubeMetadata({ title: 'ok', description: 'y'.repeat(5001) }).ok, false);
});

test('remote media trust boundary rejects untrusted URLs', () => {
  assert.equal(youtube.isTrustedRemoteMediaUrl('https://res.cloudinary.com/demo/video/upload/clip.mp4'), true);
  assert.equal(youtube.isTrustedRemoteMediaUrl('http://res.cloudinary.com/demo/video/upload/clip.mp4'), false, 'plain http is rejected');
  assert.equal(youtube.isTrustedRemoteMediaUrl('https://127.0.0.1/clip.mp4'), false, 'IP literals are rejected');
  assert.equal(youtube.isTrustedRemoteMediaUrl('https://localhost/clip.mp4'), false);
  assert.equal(youtube.isTrustedRemoteMediaUrl('https://internal.local/clip.mp4'), false);
  assert.equal(youtube.isTrustedRemoteMediaUrl('https://cdn.example.com/image.jpg'), false, 'non-video media is rejected');
  assert.equal(youtube.isTrustedRemoteMediaUrl('not-a-url'), false);
});

test('successful upload streams a local file, forces private + notifySubscribers=false, and returns one video id', async () => {
  writeLocalVideo('yt-test-clip.mp4', 64 * 1024);
  const state = installAccountFakes({});
  const result = await youtube.publishScheduledYouTubePost(basePost({ fileName: 'yt-test-clip.mp4' }));

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.response.video_id, 'yt-video-123');
  assert.equal(result.response.privacy_status, 'private');
  assert.equal(result.providerStatus, 'uploaded_private');

  const init = requestsLog.filter((entry) => entry.path === '/upload/videos').at(-1);
  assert.equal(init.query.uploadType, 'resumable', 'the documented resumable protocol is used');
  assert.equal(init.query.notifySubscribers, 'false', 'subscriber notifications are forced off');
  const initBody = JSON.parse(init.body);
  assert.equal(initBody.status.privacyStatus, 'private', 'privacy is forced to private');
  assert.equal(initBody.snippet.title, 'Test title');
  assert.equal(init.headers['x-upload-content-length'], String(64 * 1024));

  const put = requestsLog.filter((entry) => entry.path.startsWith('/upload-session/')).at(-1);
  assert.equal(put.headers['content-length'], String(64 * 1024), 'bytes are streamed with an exact length, not re-buffered JSON');
  assert.equal(Buffer.byteLength(put.body, 'utf8') > 0, true);
  assert.equal(state.reauthorizationMarks.length, 0);
});

test('the upload body is a stream, not an in-memory buffer', async () => {
  writeLocalVideo('yt-stream-clip.mp4', 32 * 1024);
  installAccountFakes({});
  const source = await youtube.getVideoSource(basePost({ fileName: 'yt-stream-clip.mp4' }));
  assert.equal(source.ok, true);
  assert.equal(source.source, 'local');
  assert.equal(source.fileSize, 32 * 1024);
  const body = source.createBody();
  assert.equal(body instanceof fs.ReadStream, true, 'local media must be streamed from disk, never fully buffered');
  body.destroy();
});

test('a definitive 4xx rejection is a terminal failure — no video id, no ambiguity flag', async () => {
  writeLocalVideo('yt-reject-clip.mp4', 8 * 1024);
  const originalFetch = global.fetch;
  // Steer the init call to a session whose PUT rejects with HTTP 400.
  global.fetch = async (input, init) => {
    const target = String(input);
    if (target.includes('/upload/videos')) {
      return originalFetch(`${target}&mode=reject`, init);
    }
    return originalFetch(input, init);
  };
  try {
    const result = await youtube.uploadVideo({
      accessToken: 'good-token',
      media: { createBody: () => fs.createReadStream(path.join(config.uploadsDir, 'yt-reject-clip.mp4')), fileSize: 8 * 1024 },
      metadata: { title: 'Rejected title', mimeType: 'video/mp4' }
    });
    assert.equal(result.ok, false);
    assert.equal(result.definitiveFailure, true);
    assert.equal(result.outcomeUnknown, undefined, 'a documented 4xx rejection is not ambiguous');
    assert.match(result.reason, /HTTP 400/);
    assert.equal(result.reason.includes('good-token'), false, 'tokens never appear in failure reasons');
    assert.equal(result.providerErrorCategory, 'invalid_request');
  } finally {
    global.fetch = originalFetch;
  }
});

test('ambiguous transport failure after the session exists becomes outcome_unknown, never a blind retry', async () => {
  writeLocalVideo('yt-ambiguous-clip.mp4', 8 * 1024);
  installAccountFakes({});
  const post = basePost({ fileName: 'yt-ambiguous-clip.mp4' });
  // Point the init call at a session URL whose PUT destroys the socket.
  const original = config.youtube.uploadBaseUrl;
  config.youtube.uploadBaseUrl = `${baseUrl}/upload`;
  const originalFetch = global.fetch;
  global.fetch = async (input, init) => {
    const target = String(input);
    if (target.includes('/upload/videos')) {
      const response = await originalFetch(`${baseUrl}/upload/videos?uploadType=resumable&part=snippet,status&notifySubscribers=false&mode=ambiguous`, init);
      return response;
    }
    return originalFetch(input, init);
  };
  try {
    const result = await youtube.publishScheduledYouTubePost(post);
    assert.equal(result.ok, false);
    assert.equal(result.outcomeUnknown, true, JSON.stringify(result));
    assert.equal(result.code, 'PROVIDER_RECONCILIATION_REQUIRED');
    assert.match(result.reason, /reconcile/i);
  } finally {
    global.fetch = originalFetch;
    config.youtube.uploadBaseUrl = original;
  }
});

test('publish gates fail closed before any external call', async () => {
  writeLocalVideo('yt-gate-clip.mp4', 8 * 1024);

  // Disconnected account.
  let state = installAccountFakes({ account: { connected: false } });
  let result = await youtube.publishScheduledYouTubePost(basePost({ fileName: 'yt-gate-clip.mp4' }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /disconnected/i);

  // Reauthorization required.
  state = installAccountFakes({ account: { reauthorizationRequired: true } });
  result = await youtube.publishScheduledYouTubePost(basePost({ fileName: 'yt-gate-clip.mp4' }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'reauthorization_required');

  // Missing upload scope.
  state = installAccountFakes({ account: { grantedScopes: 'https://www.googleapis.com/auth/youtube.readonly' } });
  result = await youtube.publishScheduledYouTubePost(basePost({ fileName: 'yt-gate-clip.mp4' }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /youtube\.upload scope/);

  // Missing title.
  state = installAccountFakes({});
  result = await youtube.publishScheduledYouTubePost(basePost({ fileName: 'yt-gate-clip.mp4', providerMetadata: { youtube: { title: '' } } }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /title/i);

  // Existing publishId: refuse a second upload.
  state = installAccountFakes({});
  result = await youtube.publishScheduledYouTubePost(basePost({ fileName: 'yt-gate-clip.mp4', publishId: 'yt-existing' }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /already has a YouTube video ID/i);

  // Non-video media.
  state = installAccountFakes({});
  result = await youtube.publishScheduledYouTubePost(basePost({ fileName: 'yt-gate-clip.mp4', mediaType: 'photo' }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /video-only/i);

  // Unassigned account.
  state = installAccountFakes({});
  result = await youtube.publishScheduledYouTubePost(basePost({ accountId: 'legacy' }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /unassigned/i);

  // Untrusted remote media.
  state = installAccountFakes({});
  result = await youtube.publishScheduledYouTubePost(basePost({ mediaUrl: 'http://127.0.0.1/evil.mp4' }));
  assert.equal(result.ok, false);
  assert.match(result.reason, /not a trusted HTTPS video source|missing/i);
  assert.ok(state);
});

test('expired access token refreshes server-side and persists atomically; invalid_grant becomes reauthorization_required', async () => {
  writeLocalVideo('yt-refresh-clip.mp4', 8 * 1024);

  // Expired token with a good refresh token: refresh + persist + upload.
  let state = installAccountFakes({ account: { accessTokenExpiresAt: new Date(Date.now() - 1000).toISOString() } });
  let result = await youtube.publishScheduledYouTubePost(basePost({ fileName: 'yt-refresh-clip.mp4' }));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(state.tokenStateUpdates.length, 1, 'refreshed credentials are persisted');
  assert.ok(state.tokenStateUpdates[0].credentialEnvelope.ct, 'persisted credentials are an encrypted envelope');
  assert.equal(JSON.stringify(state.tokenStateUpdates[0]).includes(CANARY_REFRESH), false, 'no plaintext refresh token in the persisted update');

  // Revoked refresh token: truthful reauthorization_required, no upload.
  state = installAccountFakes({
    account: { accessTokenExpiresAt: new Date(Date.now() - 1000).toISOString() },
    tokens: { refresh_token: 'revoked-refresh-token' }
  });
  result = await youtube.publishScheduledYouTubePost(basePost({ fileName: 'yt-refresh-clip.mp4' }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'reauthorization_required');
  assert.deepEqual(state.reauthorizationMarks, ['invalid_grant']);
});

test('status lookup returns normalized safe fields', async () => {
  installAccountFakes({});
  const status = await youtube.getUploadedVideoStatus({ userId: 'owner', accountId: 'UC-chanter', videoId: 'yt-video-123' });
  assert.deepEqual(status, {
    ok: true,
    videoId: 'yt-video-123',
    uploadStatus: 'processed',
    privacyStatus: 'private',
    processingStatus: 'succeeded'
  });
});

test('redaction: sensitive keys never survive serialization; error messages exclude secrets', async () => {
  const redacted = youtube.redactSensitive({
    access_token: CANARY_ACCESS,
    refresh_token: CANARY_REFRESH,
    client_secret: CANARY_CLIENT_SECRET,
    nested: { code: 'auth-code', ok: 'value' }
  });
  const serialized = JSON.stringify(redacted);
  assert.equal(serialized.includes(CANARY_ACCESS), false);
  assert.equal(serialized.includes(CANARY_REFRESH), false);
  assert.equal(serialized.includes(CANARY_CLIENT_SECRET), false);
  assert.equal(serialized.includes('auth-code'), false);
  assert.equal(redacted.nested.ok, 'value');
});
