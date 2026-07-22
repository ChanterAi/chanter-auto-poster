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
const {
  appendProviderOperationEvent,
  canonicalSha256,
  createInitialYouTubeProviderOperation,
  operationMediaBinding,
  sanitizeProviderOperation
} = require('../src/youtubeProviderOperation');

const CANARY_CLIENT_SECRET = 'CANARY-YT-CLIENT-SECRET-77aa88bb';
const CANARY_ACCESS = 'CANARY-YT-ACCESS-11cc22dd';
const CANARY_REFRESH = 'CANARY-YT-REFRESH-33ee44ff';

// Controlled Google fake. Route behavior is driven by token/session values
// so each test picks its scenario without shared mutable state.
const requestsLog = [];
const sessionRecords = new Map();
function providerVideo(mode = '') {
  return {
    id: mode === 'public' ? 'yt-video-public' : 'yt-video-123',
    status: { uploadStatus: 'uploaded', privacyStatus: mode === 'public' ? 'public' : 'private' },
    snippet: { channelId: 'UC-chanter' }
  };
}
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
      const mode = url.searchParams.get('mode') || '';
      sessionRecords.set(session, { mode, acceptedByteOffset: 0, complete: false });
      res.setHeader('Location', `http://127.0.0.1:${server.address().port}/upload-session/${session}${mode ? `?mode=${mode}` : ''}`);
      res.statusCode = 200;
      res.end();
      return;
    }

    if (req.method === 'PUT' && url.pathname.startsWith('/upload-session/')) {
      const mode = url.searchParams.get('mode') || '';
      const sessionId = url.pathname.split('/').at(-1);
      const session = sessionRecords.get(sessionId) || { mode, acceptedByteOffset: 0, complete: false };
      const contentRange = String(req.headers['content-range'] || '');
      if (contentRange.startsWith('bytes */')) {
        if (mode === 'missing') { res.statusCode = 410; res.end(); return; }
        if (session.complete) {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(providerVideo(mode)));
          return;
        }
        res.statusCode = 308;
        if (session.acceptedByteOffset > 0) res.setHeader('Range', `bytes=0-${session.acceptedByteOffset - 1}`);
        res.end();
        return;
      }
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
      if (mode === 'missing') {
        req.socket.destroy();
        return;
      }
      if (mode === 'ambiguous-once' && !session.complete) {
        session.complete = true;
        sessionRecords.set(sessionId, session);
        req.socket.destroy();
        return;
      }
      if (mode === 'partial' && !contentRange.startsWith('bytes ')) {
        session.acceptedByteOffset = 1024;
        sessionRecords.set(sessionId, session);
        res.statusCode = 308;
        res.setHeader('Range', 'bytes=0-1023');
        res.end();
        return;
      }
      session.complete = true;
      sessionRecords.set(sessionId, session);
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(providerVideo(mode)));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/videos') {
      const requestedId = url.searchParams.get('id');
      const isPublic = requestedId === 'yt-video-public';
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        items: [{
          id: requestedId,
          snippet: { channelId: 'UC-chanter', channelTitle: 'chanterCy', title: 'Test title' },
          status: { uploadStatus: 'processed', privacyStatus: isPublic ? 'public' : 'private' },
          processingDetails: { processingStatus: 'succeeded' }
        }]
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
    reauthorizationMarks: [],
    providerEvents: [],
    sessionEnvelopes: [],
    accountReads: 0,
    credentialReads: 0
  };
  storage.getYouTubeAccount = async (userId, accountId) => {
    state.accountReads += 1;
    return userId === state.account.userId && accountId === state.account.accountId ? state.account : null;
  };
  storage.getYouTubeAccountCredential = async (userId, accountId) => {
    state.credentialReads += 1;
    return userId === state.account.userId && accountId === state.account.accountId
      ? tokenVault.encryptCredentials(state.tokens)
      : null;
  };
  storage.updateYouTubeAccountTokenState = async (userId, accountId, update) => {
    state.tokenStateUpdates.push(update);
    return state.account;
  };
  storage.markYouTubeAccountReauthorizationRequired = async (userId, accountId, code) => {
    state.reauthorizationMarks.push(code);
    state.account.reauthorizationRequired = true;
    return true;
  };
  storage.bindYouTubeProviderOperationMedia = async (input) => {
    const operation = providerOperations.get(input.postId);
    const media = {
      mediaSha256: input.mediaSha256,
      mediaByteSize: input.mediaByteSize,
      mediaMimeType: input.mediaMimeType,
      mediaContainer: input.mediaContainer,
      mediaFileName: input.mediaFileName,
      mediaSourceId: input.mediaSourceId
    };
    Object.assign(operation, media, {
      bindingSha256: canonicalSha256(operationMediaBinding(operation, media)),
      operationState: 'media_preflighted'
    });
    operation.events = appendProviderOperationEvent(operation, 'media_preflight_bound').events;
    return { outcome: 'bound', safeOperation: sanitizeProviderOperation(operation) };
  };
  storage.persistYouTubeSessionLocator = async (input) => {
    const operation = providerOperations.get(input.postId);
    operation.sessionLocatorEnvelope = input.sessionLocatorEnvelope;
    operation.sessionCreatedAt = new Date().toISOString();
    operation.operationState = 'session_persisted';
    operation.events = appendProviderOperationEvent(operation, 'session_initiated').events;
    state.sessionEnvelopes.push(input.sessionLocatorEnvelope);
    state.providerEvents.push('session_persisted');
    return { outcome: 'session_persisted', safeOperation: sanitizeProviderOperation(operation) };
  };
  storage.recordYouTubeUploadAttempt = async (input) => {
    const operation = providerOperations.get(input.postId);
    operation.operationState = 'uploading';
    operation.events = appendProviderOperationEvent(operation, 'upload_put_attempted', {
      acceptedByteOffset: input.acceptedByteOffset
    }).events;
    state.providerEvents.push('upload_put_attempted');
    return { outcome: 'recorded', safeOperation: sanitizeProviderOperation(operation) };
  };
  storage.recordYouTubeAcceptedByteOffset = async (input) => {
    const operation = providerOperations.get(input.postId);
    operation.acceptedByteOffset = input.acceptedByteOffset;
    operation.operationState = 'resumable';
    operation.events = appendProviderOperationEvent(operation, 'accepted_byte_offset', input).events;
    return { outcome: 'recorded', safeOperation: sanitizeProviderOperation(operation) };
  };
  storage.recordYouTubeProviderResponse = async (input) => {
    const operation = providerOperations.get(input.postId);
    operation.externalVideoId = input.externalVideoId;
    operation.providerResponseSha256 = input.providerResponseSha256;
    operation.events = appendProviderOperationEvent(operation, 'provider_response_recorded', {
      externalVideoId: input.externalVideoId,
      responseSha256: input.providerResponseSha256
    }).events;
    operation.events = appendProviderOperationEvent(operation, 'artifact_confirmed', {
      externalVideoId: input.externalVideoId
    }).events;
    return { outcome: 'recorded', safeOperation: sanitizeProviderOperation(operation) };
  };
  storage.recordYouTubeProviderStatusReceipt = async (input) => {
    const operation = providerOperations.get(input.postId);
    operation.providerStatusReceipt = input.providerStatusReceipt;
    operation.providerStatusReceiptSha256 = input.providerStatusReceiptSha256;
    operation.operationState = input.providerStatusReceipt.privacyStatus === 'private'
      ? 'completed_private'
      : 'contradictory_public';
    operation.events = appendProviderOperationEvent(operation, 'provider_status_read', {
      externalVideoId: input.providerStatusReceipt.externalVideoId,
      receiptSha256: input.providerStatusReceiptSha256
    }).events;
    return { outcome: operation.operationState, safeOperation: sanitizeProviderOperation(operation) };
  };
  storage.recordYouTubeProviderOperationFailure = async (input) => {
    const operation = providerOperations.get(input.postId);
    operation.operationState = input.operationState;
    operation.lastOperationErrorCode = input.errorCode;
    return { outcome: input.operationState, safeOperation: sanitizeProviderOperation(operation) };
  };
  storage.getYouTubeProviderOperationInternal = async (userId, postId, accountId) => {
    const operation = providerOperations.get(postId);
    const post = providerPosts.get(postId);
    return operation && post && userId === post.userId && accountId === post.accountId
      ? { operation, post }
      : null;
  };
  storage.claimYouTubeReconciliationAttempt = async (input) => {
    const operation = providerOperations.get(input.postId);
    if (operation.reconciliationAttemptCount >= operation.reconciliationAttemptBudget) {
      return { outcome: 'budget_exhausted', safeOperation: sanitizeProviderOperation(operation) };
    }
    operation.reconciliationAttemptCount += 1;
    operation.reconciliationFencingToken += 1;
    const lease = {
      ownerId: input.ownerId,
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      attemptNumber: operation.reconciliationAttemptCount,
      operationId: operation.providerOperationId,
      fencingToken: operation.reconciliationFencingToken
    };
    operation.reconciliationLease = lease;
    operation.events = appendProviderOperationEvent(operation, 'reconciliation_lease_acquired').events;
    return { outcome: 'claimed', lease, safeOperation: sanitizeProviderOperation(operation) };
  };
  storage.releaseYouTubeReconciliationLease = async (input) => {
    const operation = providerOperations.get(input.postId);
    operation.reconciliationLease = null;
    return { outcome: 'released', safeOperation: sanitizeProviderOperation(operation) };
  };
  storage.applyYouTubeProviderReconciliationResult = async (input) => ({
    outcome: providerOperations.get(input.postId).operationState
  });
  return state;
}

const providerOperations = new Map();
const providerPosts = new Map();

function basePost(overrides = {}) {
  const post = {
    id: 'job-1',
    userId: 'owner',
    provider: 'youtube',
    platform: 'youtube',
    accountId: 'UC-chanter',
    connectedAccountId: 'youtube:UC-chanter',
    workspaceId: 'workspace-1',
    runtimeMissionId: 'graph:g:node:n',
    runtimeGraphId: 'graph:g',
    runtimeAction: 'autoposter.post.schedule',
    runtimePayloadHash: 'a'.repeat(64),
    approvedBy: 'founder',
    approvedAt: '2026-07-19T11:59:00.000Z',
    mediaType: 'video',
    mimeType: 'video/mp4',
    fileName: '',
    mediaUrl: '',
    publishId: '',
    providerMetadata: { youtube: { title: 'Test title', description: 'Test description', privacyStatus: 'private', notifySubscribers: false } },
    ...overrides
  };
  if (post.accountId !== 'legacy') {
    const operation = createInitialYouTubeProviderOperation({ queueId: post.id, post, attemptNumber: 1 });
    providerOperations.set(post.id, operation);
    post.providerOperation = sanitizeProviderOperation(operation);
  }
  providerPosts.set(post.id, post);
  return post;
}

function writeLocalVideo(name, bytes) {
  fs.mkdirSync(config.uploadsDir, { recursive: true });
  const filePath = path.join(config.uploadsDir, name);
  const size = Math.max(32, bytes);
  const payload = randomBytes(size);
  payload.writeUInt32BE(24, 0);
  payload.write('ftyp', 4, 4, 'ascii');
  payload.write('mp42', 8, 4, 'ascii');
  payload.writeUInt32BE(0, 12);
  payload.write('isom', 16, 4, 'ascii');
  payload.write('mp42', 20, 4, 'ascii');
  payload.writeUInt32BE(size - 24, 24);
  payload.write('mdat', 28, 4, 'ascii');
  fs.writeFileSync(filePath, payload);
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

test('ADV-03 approved-media byte mismatch fails before credentials or provider endpoints', async () => {
  const filePath = writeLocalVideo('yt-approved-mismatch.mp4', 4096);
  const state = installAccountFakes({});
  const bytes = fs.readFileSync(filePath);
  const post = basePost({
    id: 'job-approved-mismatch',
    fileName: 'yt-approved-mismatch.mp4',
    providerProofMode: true,
    approvedMedia: {
      sha256: createHash('sha256').update(Buffer.concat([bytes, Buffer.from('changed')])).digest('hex'),
      byteSize: bytes.length,
      mimeType: 'video/mp4',
      fileName: 'yt-approved-mismatch.mp4',
      container: 'mp4'
    }
  });
  const uploadCallsBefore = requestsLog.filter((entry) => entry.path === '/upload/videos').length;
  const result = await youtube.publishScheduledYouTubePost(post);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'APPROVED_MEDIA_MISMATCH');
  assert.equal(state.accountReads, 0, 'provider account metadata is not read before approved-byte comparison');
  assert.equal(state.credentialReads, 0, 'credentials are not read before approved-byte comparison');
  assert.equal(requestsLog.filter((entry) => entry.path === '/upload/videos').length, uploadCallsBefore);
  assert.equal(providerOperations.get(post.id).operationState, 'terminal_failure');
});

test('successful upload streams a local file, forces private + notifySubscribers=false, and returns one video id', async () => {
  writeLocalVideo('yt-test-clip.mp4', 64 * 1024);
  const state = installAccountFakes({});
  const result = await youtube.publishScheduledYouTubePost(basePost({ fileName: 'yt-test-clip.mp4' }));

  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.response.video_id, 'yt-video-123');
  assert.equal(result.response.privacy_status, 'private');
  assert.equal(result.providerStatus, 'uploaded_private');
  assert.deepEqual(result.providerVerification, {
    ok: true,
    provider: 'youtube',
    externalVideoId: 'yt-video-123',
    channelId: 'UC-chanter',
    channelTitle: 'chanterCy',
    channelHandle: '@chanterCy',
    title: 'Test title',
    privacyStatus: 'private',
    uploadStatus: 'processed',
    processingStatus: 'succeeded',
    verifiedAt: result.providerVerification.verifiedAt,
    uploadMethod: 'resumable'
  });
  assert.equal(Number.isFinite(Date.parse(result.providerVerification.verifiedAt)), true);

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
  assert.deepEqual(state.providerEvents.slice(0, 2), ['session_persisted', 'upload_put_attempted']);
  assert.equal(state.sessionEnvelopes.length, 1);
  assert.equal(tokenVault.isCredentialEnvelope(state.sessionEnvelopes[0]), true);
  assert.equal(JSON.stringify(state.sessionEnvelopes[0]).includes('/upload-session/'), false, 'the locator is encrypted at rest');
  assert.equal(JSON.stringify(result).includes('/upload-session/'), false, 'the locator never reaches the result');
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

test('restart after partial bytes queries and resumes the same persisted session without a second initiation', async () => {
  writeLocalVideo('yt-partial-clip.mp4', 8 * 1024);
  installAccountFakes({});
  const post = basePost({ id: 'job-partial', fileName: 'yt-partial-clip.mp4' });
  const originalFetch = global.fetch;
  global.fetch = async (input, init) => {
    const target = String(input);
    return originalFetch(target.includes('/upload/videos') ? `${target}&mode=partial` : input, init);
  };
  try {
    const first = await youtube.publishScheduledYouTubePost(post);
    assert.equal(first.outcomeUnknown, true);
    assert.equal(providerOperations.get(post.id).acceptedByteOffset, 1024);
    const sessionPathsBefore = requestsLog
      .filter((entry) => entry.path.startsWith('/upload-session/'))
      .map((entry) => entry.path);
    const reconciled = await youtube.reconcileYouTubeProviderOperation({
      userId: post.userId,
      postId: post.id,
      accountId: post.accountId
    });
    assert.equal(reconciled.classification, 'completed_private');
    const initCalls = requestsLog.filter((entry) => entry.path === '/upload/videos' && entry.query.mode === 'partial');
    assert.equal(initCalls.length, 1, 'reconciliation never creates a second session');
    const sessionRequests = requestsLog.filter((entry) => entry.path === sessionPathsBefore.at(-1));
    assert.equal(sessionRequests.some((entry) => String(entry.headers['content-range']).startsWith('bytes */')), true, 'same-session status query ran');
    assert.equal(sessionRequests.some((entry) => String(entry.headers['content-range']).startsWith('bytes 1024-')), true, 'same-session missing range resumed');
    const safe = sanitizeProviderOperation(providerOperations.get(post.id));
    assert.equal(safe.operationState, 'completed_private');
    assert.equal(safe.mutationSummary.providerSessionInitiationCount, 1);
    assert.equal(safe.mutationSummary.confirmedVideoArtifactCount, 1);
    assert.equal(safe.mutationSummary.existingResourceUpdateCount, 0);
    assert.equal(safe.mutationSummary.deleteCount, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test('restart after an ambiguous completion recovers the video ID from the same completed session', async () => {
  writeLocalVideo('yt-complete-recovery.mp4', 8 * 1024);
  installAccountFakes({});
  const post = basePost({ id: 'job-complete-recovery', fileName: 'yt-complete-recovery.mp4' });
  const originalFetch = global.fetch;
  global.fetch = async (input, init) => {
    const target = String(input);
    return originalFetch(target.includes('/upload/videos') ? `${target}&mode=ambiguous-once` : input, init);
  };
  try {
    const first = await youtube.publishScheduledYouTubePost(post);
    assert.equal(first.outcomeUnknown, true);
    const reconciled = await youtube.reconcileYouTubeProviderOperation({ userId: 'owner', postId: post.id, accountId: post.accountId });
    assert.equal(reconciled.classification, 'completed_private');
    assert.equal(providerOperations.get(post.id).externalVideoId, 'yt-video-123');
    assert.equal(requestsLog.filter((entry) => entry.path === '/upload/videos' && entry.query.mode === 'ambiguous-once').length, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test('missing same-session reconciliation fails closed without creating a replacement session', async () => {
  writeLocalVideo('yt-missing-session.mp4', 8 * 1024);
  installAccountFakes({});
  const post = basePost({ id: 'job-missing-session', fileName: 'yt-missing-session.mp4' });
  const originalFetch = global.fetch;
  global.fetch = async (input, init) => {
    const target = String(input);
    return originalFetch(target.includes('/upload/videos') ? `${target}&mode=missing` : input, init);
  };
  try {
    const first = await youtube.publishScheduledYouTubePost(post);
    assert.equal(first.outcomeUnknown, true);
    const reconciled = await youtube.reconcileYouTubeProviderOperation({ userId: 'owner', postId: post.id, accountId: post.accountId });
    assert.equal(reconciled.classification, 'provider_missing');
    assert.equal(providerOperations.get(post.id).operationState, 'provider_missing');
    assert.equal(
      requestsLog.filter((entry) => entry.path === '/upload/videos' && entry.query.mode === 'missing').length,
      1,
      'a missing session is never replaced automatically'
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('tampered encrypted session locator fails closed before a provider status call', async () => {
  writeLocalVideo('yt-tamper.mp4', 8 * 1024);
  installAccountFakes({});
  const post = basePost({ id: 'job-tamper', fileName: 'yt-tamper.mp4' });
  const originalFetch = global.fetch;
  global.fetch = async (input, init) => {
    const target = String(input);
    return originalFetch(target.includes('/upload/videos') ? `${target}&mode=ambiguous` : input, init);
  };
  try {
    await youtube.publishScheduledYouTubePost(post);
    const raw = providerOperations.get(post.id);
    raw.sessionLocatorEnvelope = { ...raw.sessionLocatorEnvelope, tag: 'AA' };
    const before = requestsLog.length;
    const result = await youtube.reconcileYouTubeProviderOperation({ userId: 'owner', postId: post.id, accountId: post.accountId });
    assert.equal(result.classification, 'session_locator_decrypt_failed');
    assert.equal(requestsLog.length, before);
    assert.equal(JSON.stringify(result).includes('/upload-session/'), false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('ambiguous same-session reconciliation remains fail-closed and obeys its durable budget', async () => {
  writeLocalVideo('yt-still-ambiguous.mp4', 8 * 1024);
  installAccountFakes({});
  const post = basePost({ id: 'job-still-ambiguous', fileName: 'yt-still-ambiguous.mp4' });
  const originalFetch = global.fetch;
  global.fetch = async (input, init) => {
    const target = String(input);
    return originalFetch(target.includes('/upload/videos') ? `${target}&mode=ambiguous` : input, init);
  };
  try {
    await youtube.publishScheduledYouTubePost(post);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await youtube.reconcileYouTubeProviderOperation({ userId: 'owner', postId: post.id, accountId: post.accountId });
      assert.equal(result.classification, 'outcome_unknown');
    }
    const before = requestsLog.length;
    const exhausted = await youtube.reconcileYouTubeProviderOperation({ userId: 'owner', postId: post.id, accountId: post.accountId });
    assert.equal(exhausted.classification, 'budget_exhausted');
    assert.equal(requestsLog.length, before, 'exhausted budget performs no provider call');
  } finally {
    global.fetch = originalFetch;
  }
});

test('media identity drift blocks same-session resume without creating another session', async () => {
  const initCountBefore = requestsLog.filter((entry) => entry.path === '/upload/videos' && entry.query.mode === 'partial').length;
  const filePath = writeLocalVideo('yt-media-drift.mp4', 8 * 1024);
  installAccountFakes({});
  const post = basePost({ id: 'job-media-drift', fileName: 'yt-media-drift.mp4' });
  const originalFetch = global.fetch;
  global.fetch = async (input, init) => {
    const target = String(input);
    return originalFetch(target.includes('/upload/videos') ? `${target}&mode=partial` : input, init);
  };
  try {
    await youtube.publishScheduledYouTubePost(post);
    writeLocalVideo('yt-media-drift.mp4', 8 * 1024);
    const result = await youtube.reconcileYouTubeProviderOperation({ userId: 'owner', postId: post.id, accountId: post.accountId });
    assert.equal(result.classification, 'media_identity_drift');
    assert.equal(
      requestsLog.filter((entry) => entry.path === '/upload/videos' && entry.query.mode === 'partial').length - initCountBefore,
      1
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('public provider read-back becomes a critical contradiction instead of success', async () => {
  writeLocalVideo('yt-public-contradiction.mp4', 8 * 1024);
  installAccountFakes({});
  const post = basePost({ id: 'job-public', fileName: 'yt-public-contradiction.mp4' });
  const originalFetch = global.fetch;
  global.fetch = async (input, init) => {
    const target = String(input);
    return originalFetch(target.includes('/upload/videos') ? `${target}&mode=public` : input, init);
  };
  try {
    const result = await youtube.publishScheduledYouTubePost(post);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'PROVIDER_VISIBILITY_CONTRADICTION');
    assert.equal(providerOperations.get(post.id).operationState, 'contradictory_public');
  } finally {
    global.fetch = originalFetch;
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
    channelId: 'UC-chanter',
    channelTitle: 'chanterCy',
    channelHandle: '',
    title: 'Test title',
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
