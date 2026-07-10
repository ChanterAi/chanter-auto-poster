# AutoPoster YouTube Provider (Provider #2) — Part 3

Status: Stage A complete (implementation + local validation). Stage B
(supervised live proof against the real `@chanterCy` channel) requires the
Credential Handoff Packet actions and has not run yet.

## Architecture

```
AutoPoster Website ──┐
Agent Runtime / MCP ─┴─> Shared Application Service (autoposterApplicationService.js)
                           ├─ Provider Registry            src/providers.js
                           ├─ Connected Account Resolution src/connectedAccounts.js + src/storage.js
                           ├─ Ownership / Approval         (unchanged Part 1/2 gates)
                           ├─ Media Validation             src/mediaPolicy.js (video-only)
                           └─ Canonical Queue (Firestore `posts`)
                                 └─ Queue Worker  src/scheduler.js (claim → dispatch → finalize)
                                       └─ YouTube Provider Adapter  src/youtube.js
                                             └─ YouTube Data API v3 (OAuth + resumable upload)
```

One queue, one application-service path, one connected-account truth.
Neither MCP, the Runtime, browser code, nor views ever call Google.

## OAuth endpoints (server-side authorization-code flow + PKCE S256)

| Route | Method | Purpose |
|---|---|---|
| `/connect/youtube` | GET (admin) | Start authorization. `?reauthorize=<channelId>` reauthorizes an existing connection. |
| `/auth/youtube/callback` | GET (admin) | Code exchange, channel resolution, account persistence. |
| `/connect/youtube/select` | POST (admin, CSRF) | Explicit channel selection when Google returns multiple channels. |
| `/disconnect/youtube` | POST (admin, CSRF) | Revoke at Google (best effort) + always remove local credentials. |
| `/api/youtube/posts/:postId/status` | GET (admin API) | Safe status lookup (`videos.list` `status,processingDetails`). |

Exact callback URIs (must match the Google OAuth Web client registration
byte-for-byte — scheme, host, port, path, no trailing slash):

- Local: `http://localhost:10000/auth/youtube/callback` (the real local port
  from `.env` `PORT=10000`)
- Production: `https://poster.chanterr.com/auth/youtube/callback`

Authorize request: `response_type=code`, `access_type=offline`,
`include_granted_scopes=true`, `code_challenge_method=S256`, exact
`redirect_uri`, cryptographically random single-use `state`.
`prompt=consent` is sent only when a refresh token must be obtained or
restored (first connect, or reauthorizing an account without a usable
refresh token) — never on a routine reconnect.

## OAuth state / CSRF model

State is a 32-byte random id referencing a SERVER-SIDE record
(`oauthTransactions` collection, `src/oauthStateStore.js`) bound to: user,
provider, validated internal return path (`auth.safeReturnTo` — arbitrary
return URLs are replaced), PKCE verifier, mode (connect/reauthorize), and
the intended channel for reauthorize. Records expire after 10 minutes and
are consumed transactionally (read+delete), so a state value is invalid
after use, after expiry, after replay, for another user, and for another
provider. A `youtube_oauth_state` HTTP-only cookie binds the callback to
the initiating browser as defense in depth. Authorization codes are never
logged, rendered, or echoed. All POST routes sit behind the global
Origin/Referer CSRF check.

## Scopes (least privilege, evidence-based)

| Scope | Operation it authorizes | Evidence |
|---|---|---|
| `https://www.googleapis.com/auth/youtube.upload` | `videos.insert` (the upload itself) | videos.insert Authorization list includes youtube.upload. |
| `https://www.googleapis.com/auth/youtube.readonly` | `channels.list?mine=true` (channel identity at connect time) and `videos.list` `status`/`processingDetails` (post-upload status) | channels.list / videos.list do not accept youtube.upload; youtube.readonly ("View your YouTube account") is the narrowest read scope covering both. |

`youtube`, `youtube.force-ssl`, and `youtubepartner` are deliberately NOT
requested. `include_granted_scopes=true` keeps authorization incremental.
A 403 on `channels.list` is normalized to a truthful missing-scope error.

## Token custody

- `src/tokenVault.js`: versioned AES-256-GCM envelopes
  (`{v, alg, kv, iv, ct, tag}`), fresh random 12-byte IV per encryption,
  authentication tag verified on decrypt, key versions
  (`TOKEN_ENCRYPTION_KEY` = v1; future `TOKEN_ENCRYPTION_KEY_V<N>`), no
  plaintext fallback, normalized errors with no key/cipher material.
- Envelopes live only in the `credential` field of `youtubeAccounts`
  documents; the safe serializer (`youtubeAccountFromDoc`) never returns
  them. Queue items, connected-account views, Runtime evidence, MCP
  responses, and logs carry token PRESENCE metadata only
  (`tokenPresent`, `refreshTokenPresent`, `accessTokenExpiresAt`,
  `grantedScopes`, `reauthorizationRequired`, `lastRefreshAt`,
  `lastRefreshFailureCode`, `credentialVersion`).
- Refresh: server-side, 5-minute expiry buffer, atomic envelope+metadata
  persist, refresh token preserved unless Google rotates it, and
  `invalid_grant`/revocation transitions the account to
  `reauthorization_required` truthfully.
- A reconnect that returns no new refresh token merges the previously
  stored (encrypted) refresh token forward; if no refresh path exists the
  account is saved but immediately marked `reauthorization_required` — it
  is never presented as ready.

## Testing-mode refresh-token limitation

The Google OAuth consent screen is in **Testing** status: Google may expire
refresh tokens after ~7 days and caps test users. When the refresh token
stops working, the connected account transitions to
`reauthorization_required` (shown on the site with a Reauthorize control) —
it is not disguised as a generic provider failure. Publishing the consent
screen removes the 7-day limit later.

## Environment variables

Local `.env` (never committed) and production environment:
`YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_REDIRECT_URI`,
`TOKEN_ENCRYPTION_KEY`, optional `YOUTUBE_SCOPES`, `YOUTUBE_ENABLED`,
`YOUTUBE_PRIVATE_ONLY` (default true; setting false HALTS the provider —
no non-private path is implemented), `YOUTUBE_REQUEST_TIMEOUT_MS`,
`YOUTUBE_UPLOAD_TIMEOUT_MS`, `YOUTUBE_MAX_VIDEO_BYTES`, and (tests only)
`YOUTUBE_OAUTH_AUTH_URL` / `YOUTUBE_OAUTH_TOKEN_URL` /
`YOUTUBE_OAUTH_REVOKE_URL` / `YOUTUBE_API_BASE_URL` /
`YOUTUBE_UPLOAD_BASE_URL` endpoint overrides. Placeholders are in
`.env.example`. Missing configuration reports
`implemented: true, configured: false, available: false` and never crashes
TikTok operation.

## Connected-account lifecycle

`youtubeAccounts` (one doc per channel): identity (channelId, handle,
title, thumbnail), connection + readiness state, safe token metadata,
encrypted credential envelope. Ownership is enforced on every read/write;
a channel bound to another app user cannot be re-bound. Reconnect updates
the SAME document (same `connectedAccountId`), never a duplicate.
Multiple-channel Google accounts get a restrained single-use selection view
(`youtube-select-channel.ejs`); only channels Google returned in that
authorization are selectable, and reauthorize refuses to swap channels.
Disconnect (POST + CSRF) attempts Google revocation, always clears local
credentials, reports revocation failures truthfully, and never touches
TikTok records.

## Provider registry state

`providers.js` — YouTube: `implementationStatus` ACTIVE only when fully
configured (otherwise DISABLED); capabilities: video upload (private only),
no images, OAuth connection, remote status lookup, approval required;
public/unlisted publishing, native `publishAt` scheduling, subscriber
notifications, deletion, analytics, thumbnails, live streaming, and
playlists all fail closed. `publishingPolicy` documents the forced
`private` + `notifySubscribers=false`. The product queue remains the only
scheduler.

## Canonical queue fields (YouTube jobs)

Existing canonical fields (`provider`, `connectedAccountId`, `accountId`,
owner, media, schedule, approval, `idempotencyKey`, `creationSource`,
`publishId`, timestamps) plus the bounded
`providerMetadata.youtube = { title, description, privacyStatus: 'private',
notifySubscribers: false }` — privacy and notifications are locked at the
storage write chokepoint regardless of caller input. `providerStatus`
records provider-reported state (`uploaded_private`,
`provider_reconciliation_required`). Queue records never contain
credentials. Website- and Runtime-created YouTube jobs share this shape.
Legacy provider-less jobs still normalize to TikTok; explicit unknown
providers fail closed.

## Upload method

Documented YouTube resumable protocol, two steps:
`POST /upload/youtube/v3/videos?uploadType=resumable&part=snippet,status&notifySubscribers=false`
(JSON metadata, `X-Upload-Content-Length`) → session URL → `PUT` of the
video bytes as a STREAM (local `fs.createReadStream` or the trusted remote
body; never fully buffered). Remote media must be HTTPS on a DNS-named
host (IP literals, localhost, `.local`/`.internal` rejected), a video by
`mediaPolicy`, no redirects followed, mandatory Content-Length, and within
`YOUTUBE_MAX_VIDEO_BYTES`. Timeouts apply to every call.

## Duplicate and ambiguous-outcome behavior

- The worker's transactional claim (unchanged) plus a `publishId` guard on
  claim AND inside the adapter mean a job with a stored video ID can never
  be uploaded again — including force mode and lock-reclaim retries.
- Idempotent scheduling (idempotency key → deterministic document ID with
  `create()` semantics) means a duplicate Runtime/MCP mission converges on
  one queue job.
- Session-init failures (`sessionCreated: false`) are the only
  automatically retryable upload failures; documented 4xx rejections during
  the session are terminal with no video created.
- Any non-definitive outcome after the session exists (timeout, socket
  drop, 5xx, 2xx without a video resource) finalizes the job as
  **`outcome_unknown`** with `providerStatus:
  provider_reconciliation_required`: not success, not clean failure, never
  blind-retried, out of the claimable pool, and rendered on the site with
  an explicit warning that retrying without checking YouTube Studio could
  create a duplicate. A human resolves it (delete, or verify + reset via
  the operator retry action).
- The resumable session URL is treated as sensitive operational state: it
  exists only inside one adapter invocation and is never persisted,
  returned, or logged. Session RESUME across attempts is not implemented
  (known limitation below).

## Private-only safety policy

`privacyStatus` is hard-coded to `private` and `notifySubscribers` to
`false` in the adapter request builder; the storage chokepoint locks the
same values into queue metadata; `YOUTUBE_PRIVATE_ONLY=false` does not
unlock anything — it halts the provider. No code path can produce a public
or unlisted video in Part 3. `publishAt` is never set.

## Status vocabulary

`pending` / `scheduled` (queued, may still be awaiting approval — approval
state is a separate field), `processing` (uploading), `posted` +
`providerStatus: uploaded_private`, `failed`, `outcome_unknown` +
`provider_reconciliation_required`, and account-level
`reauthorization_required`. Upload success is displayed distinctly from
processing completion; `/api/youtube/posts/:postId/status` reads the real
`processingStatus` with the readonly scope.

## Supervised smoke-test procedure (Stage B)

1. Verify credentials exist only in the local untracked `.env`; re-scan git.
2. Start the real server locally (`npm start`, port 10000).
3. Connect YouTube; complete Google consent manually; confirm the connected
   channel is `@chanterCy`.
4. Create one tiny test-video job targeting YouTube with an explicit title;
   confirm the file choice with the operator first.
5. Approve it in the Release Queue (human gate).
6. Let the worker execute (cron tick or Publish Now).
7. Verify exactly one video ID, Private visibility in YouTube Studio, the
   same truth on the AutoPoster site, no duplicate upload, and a clean
   secret scan of logs and git diff.

## Known limitations

- Resumable sessions are not resumed across worker attempts; ambiguity
  fails safe to `outcome_unknown` instead.
- YouTube job metadata (title/description/schedule) is not editable after
  intake; delete and recreate the draft.
- Queue actions (approve/publish) currently require an admin session that
  also has a connected TikTok account (`requireConnectedTikTokAccount`);
  fine for this deployment where TikTok is Provider #1.
- `selfDeclaredMadeForKids` is not set; the channel-level default applies.
- Google Testing-mode refresh-token expiry (see above).
- Status lookup is on-demand (API route), not a background poller.

## Production verification requirements

Before production use: register the production redirect URI on the same
OAuth client, set the production env vars (including a distinct
`TOKEN_ENCRYPTION_KEY`), and re-run the supervised smoke test against
`https://poster.chanterr.com`. Publishing the OAuth consent screen removes
the Testing-mode token expiry.

## Part 4 readiness

The provider registry, connected-account domain, encrypted custody, queue
metadata pattern, worker dispatch, and Runtime/MCP schedule contract are
now multi-provider. Provider #3 needs: a config block, an adapter module,
a registry definition, storage account functions, and UI state — no
queue/worker/service rework.
