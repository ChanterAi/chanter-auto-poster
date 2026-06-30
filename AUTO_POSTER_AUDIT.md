# CHANTER Auto Poster — Technical Audit Report

**Date:** 2026-06-30  
**Auditor:** chanter assist (automated)  
**Scope:** Full codebase audit before new feature work  
**Constraints:** No new features, no destructive changes, no real TikTok posts, no production data modification

---

## 1. Executive Summary

CHANTER Auto Poster is a Node.js/Express application for scheduling and publishing TikTok content, backed by Firestore and deployed on Render. The codebase is well-structured for an MVP: clean separation of concerns, Firestore transactions for atomic job claiming, multi-account TikTok support, and a comprehensive auto-caption/auto-music pipeline.

**Build:** ✅ Passes (syntax check + Vite build)  
**Tests:** ✅ 35/35 pass  
**Architecture:** Solid Firestore-backed queue with transactional claiming  
**Security:** A few P0/P1 issues need attention before production hardening  

The most critical finding is **missing CSRF protection** on all state-changing POST routes. Secondary concerns include git-tracked data files, SHA-256 for admin password hashing, and no retry path for failed posts from the UI.

---

## 2. Current Architecture Map

```
chanter-auto-poster/
├── src/
│   ├── server.js          # Express app bootstrap, error handler, startup validation
│   ├── config.js          # Centralized env var loading & defaults
│   ├── routes.js          # All HTTP routes: auth, upload, schedule, TikTok/IG OAuth, cron tick
│   ├── auth.js            # Admin session (HMAC-signed cookie), login rate limiting
│   ├── firestore.js       # Firebase Admin SDK init (lazy), collection helpers
│   ├── storage.js         # CRUD for posts/settings/accounts, Cloudinary upload, scheduling logic
│   ├── postsMapper.js     # Firestore doc ↔ flat post object mapping
│   ├── scheduler.js       # Cron tick: findDueJobs → claimPost (transaction) → publish → finalize
│   ├── tiktok.js          # TikTok OAuth, token refresh, photo/video publish via Content Posting API
│   ├── instagram.js       # Instagram Graph API (disabled, dry-run mode)
│   ├── cloudinary.js      # Cloudinary upload/destroy with retry & health check
│   ├── autoCaption.js     # FFmpeg frame extraction, audio transcription, AI caption orchestration
│   ├── autoCaptionProviders.js  # Gemini/OpenAI/Qwen provider implementations
│   ├── autoMusic.js       # Music catalog, track selection, FFmpeg mixing, signed token verification
│   ├── ping-scheduler.js  # Standalone cron job entrypoint (Render Cron Job)
│   ├── views/
│   │   ├── index.ejs      # Main dashboard (EJS server-rendered)
│   │   └── admin-login.ejs
│   ├── pages/
│   │   ├── dashboard-accounting.mjs  # Dashboard data helpers
│   │   ├── AutoPosterDashboard.jsx   # React dashboard component
│   │   └── PromptEvolverPage.jsx     # Prompt evolver React page
│   ├── components/PromptEvolver/      # React prompt engineering UI
│   ├── dashboard-main.jsx             # React dashboard entry
│   └── prompt-evolver-main.jsx        # React prompt evolver entry
├── test/                   # 13 test files, 35 tests total
├── render.yaml             # Render Blueprint: web service + cron job
├── firebase.json           # Firestore config
├── firestore.indexes.json  # 4 composite indexes
├── firestore.rules         # Server-only access (deny all client access)
├── vite.config.mjs         # Vite build for React dashboard
├── package.json            # Node 22, Express 4, Firebase Admin 13
└── .env / .env.example
```

**Deployment topology:**

```
┌─────────────────────┐     every minute     ┌──────────────────────┐
│  Render Cron Job    │ ──── x-cron-secret ── │  Render Web Service  │
│  (ping-scheduler)   │     GET /api/cron/tick│  (Express app)       │
└─────────────────────┘                       │                      │
                                               │  ┌──────────────┐   │
                                               │  │ Firestore    │── │ posts/{id}
                                               │  │ (Admin SDK)  │── │ tiktokAccounts/{id}
                                               │  └──────────────┘── │ config/{doc}
                                               │                      │
                                               │  ┌──────────────┐   │
                                               │  │ Cloudinary   │   │
                                               │  │ (media store)│   │
                                               │  └──────────────┘   │
                                               │                      │
                                               │  TikTok API          │
                                               │  (Direct Post)       │
                                               └──────────────────────┘
```

---

## 3. Posting Flow Trace

### Photo Post Flow
```
1. User uploads image(s) via POST /upload
2. → multer saves to uploads/ (temporary)
3. → storage.addUploadedPosts() uploads to Cloudinary
4. → Cloudinary secure_url stored as mediaUrl in Firestore post doc
5. → autoSchedulePosts() assigns scheduledAt (next available day at dailyPostTime)
6. → Post status = "scheduled"

7. Render Cron Job hits GET /api/cron/tick every minute
8. → scheduler.runSchedulerTick()
9. → reclaimStaleLocks() (recover crashed jobs)
10. → findDueJobs() queries: status=="scheduled" AND scheduledAt <= now
11. → claimPost() runs Firestore transaction:
      - Read post doc
      - Check status is "scheduled" (not "processing")
      - Write status="processing", lockedAt, lockedBy, claimAttempts++
      - Return claimed post
12. → tiktok.publishPhotoPost(post):
      - Resolve TikTok account credentials via accountId
      - Check/refresh token (5-min buffer before expiry)
      - Query creator info for privacy_level_options
      - Build payload: PULL_FROM_URL, photo_images=[mediaUrl]
      - POST to https://open.tiktokapis.com/v2/post/publish/content/init/
13. → finalize():
      - Firestore transaction: verify lock ownership
      - If ok: status="posted", postedAt=now
      - If !ok: status="failed", errorMessage recorded
```

### Video Post Flow
```
Same as above through step 11, then:
12. → tiktok.publishVideoPost(post):
      - Get video source (local file or remote URL download)
      - Calculate chunk size (5MB min, 64MB max)
      - POST to video/init/ with source_info: FILE_UPLOAD
      - Upload chunks via PUT to upload_url with Content-Range
      - Cancel/cleanup video source stream
13. → finalize() (same as photo)
```

### Failure Points Identified

| Step | Failure | Current Handling |
|------|---------|-----------------|
| Cloudinary upload | Network error, credentials | Retry (3 attempts, exponential backoff); fallback to public URL if provided |
| Firestore claim | Transaction contention | Returns null (skipped) — safe |
| TikTok token refresh | Expired refresh token | Returns `{ ok: false, mode: "manual" }` — post stays failed |
| TikTok API call | 403 (unaudited app) | Specific error message about Disconnect/reconnect |
| TikTok API call | Network timeout | AbortSignal.timeout (30s request, 15min upload) |
| Crash mid-publish | Process dies after claim | reclaimStaleLocks() after SCHEDULER_STALE_LOCK_MINUTES (20min) resets to "scheduled" or "failed" after max attempts |
| Crash after TikTok accepts | Process dies before finalize | **Duplicate risk**: retry will re-publish — acknowledged in ARCHITECTURE.md |

### Privacy/Status Defaults

- ✅ `TIKTOK_PRIVACY_LEVEL` defaults to `SELF_ONLY`
- ✅ `resolvePrivacyLevel()` falls back to `SELF_ONLY` if requested level unavailable
- ✅ New posts created with `privacyLevel: config.tiktok.privacyLevel || 'SELF_ONLY'`
- ✅ `disableDuet` and `disableStitch` default to `true` for photo posts (per TikTok guidelines)
- ✅ `contentDisclosure` defaults to `false`
- ✅ Instagram `testMode` defaults to `true`, `publishEnabled` defaults to `false`

---

## 4. Scheduling / Queue Risk Analysis

### Firestore Job Schema (posts/{postId})

| Field | Type | Purpose |
|-------|------|---------|
| `status` | string | pending → scheduled → processing → posted/failed |
| `scheduledAt` | Timestamp | When to publish (canonical) |
| `scheduledTimeUTC` | Timestamp | Legacy field (pre-migration) |
| `lockedAt` | Timestamp | When worker claimed the post |
| `lockedBy` | string | Worker ID (instance-UUID) |
| `claimAttempts` | number | Incremented on each claim; max 5 |
| `userId` | string | Owner (placeholder "owner" today) |
| `accountId` | string | TikTok open_id owning this job |
| `tiktokOpenId` | string | Redundant with accountId (migration compatibility) |

### Strengths

1. **Atomic claiming**: `claimPost()` uses Firestore transaction — prevents double-publish even with concurrent workers
2. **Stale lock recovery**: `reclaimStaleLocks()` runs before every tick, reclaims posts stuck in "processing" > 20 min
3. **Max retry limit**: After `SCHEDULER_MAX_CLAIM_ATTEMPTS` (5), stale posts are marked "failed" instead of looping
4. **External cron**: Render Cron Job (every minute) wakes sleeping web service — doesn't rely on in-process timers
5. **Idempotent ticks**: Multiple overlapping ticks are safe due to transactional claiming
6. **Firestore indexes**: 4 composite indexes configured for all query patterns

### Risks

| Risk | Severity | Detail |
|------|----------|--------|
| **Duplicate on crash after TikTok accept** | P1 | If TikTok accepts the post but the app crashes before `finalize()`, `reclaimStaleLocks()` will retry and create a real duplicate. No `publish_id` status check exists. |
| **Legacy dual-query** | P2 | `findDueJobs()` runs two queries (canonical `scheduled` + legacy `pending`) and dedupes via Map. The legacy query should be removed after migration is confirmed complete. |
| **No missed-job alerting** | P2 | If the cron job stops running, overdue posts silently wait. No alert when a post's scheduledAt is long past due. |
| **Render starter plan sleep** | P1 | Starter plan services sleep after ~15 min inactivity. The every-minute cron ping should prevent this, but if the cron job itself fails, the web service sleeps and posts are missed. |
| **`claimAttempts` not reset on manual retry** | P2 | When a user clicks "Back to pending", `claimAttempts` is not reset. After 5 total attempts across the post's lifetime, the scheduler will mark it "failed" again immediately. |

---

## 5. Auth / Token / Account Risk Analysis

### TikTok OAuth

- **Flow**: Authorization Code → token exchange → open_id + access_token + refresh_token
- **State validation**: ✅ Random UUID in cookie, verified on callback
- **Token storage**: Firestore `tiktokAccounts/{encodedOpenId}` — server-only, Firestore rules deny client access
- **Token refresh**: ✅ 5-minute buffer before expiry, automatic refresh on `getActiveTikTokAuth()`
- **Disconnect**: Sets `connected: false`, clears tokens, preserves account record and job history
- **Multi-account**: ✅ Each TikTok account stored separately by open_id; jobs reference `accountId`
- **Account switching**: Browser cookie `autoposter_tiktok_account_id` selects active account

### Admin Authentication

- **Password**: Single admin password from env (`ADMIN_PASSWORD`), must be ≥12 chars
- **Hashing**: SHA-256 hash of password, timing-safe comparison — **not a password hashing algorithm** (see P1 below)
- **Session**: HMAC-signed token in httpOnly cookie, configurable expiry (default 12h)
- **Rate limiting**: 5 failed attempts per IP per 15-min window — **in-memory** (resets on restart)

### Risks

| Risk | Severity | Detail |
|------|----------|--------|
| **SHA-256 for password** | P1 | SHA-256 is a fast hash, not a password hash. Should use bcrypt/argon2/scrypt. |
| **In-memory rate limiting** | P1 | `loginAttempts` Map resets on server restart. An attacker who can trigger a restart gets a fresh window. |
| **Single admin password** | P2 | No multi-user auth. `userId` is a placeholder ("owner"). The plumbing for multi-user exists but isn't wired. |
| **Token refresh failure** | P1 | If `refreshTikTokToken()` fails, the account stays "connected" but publishing fails. No automatic disconnect or user notification. |
| **No session revocation** | P2 | Admin session tokens can't be revoked server-side; they expire based on time only. |

---

## 6. Production Blockers Ranked

### P0 — Must Fix Before Using Seriously

#### P0-1: No CSRF Protection on POST Routes
**Files:** `src/routes.js` (all POST routes), `src/server.js`  
**Issue:** All state-changing operations (upload, delete, schedule, post-now, settings, account switching) accept simple form-encoded POSTs with no CSRF token. The admin session cookie uses `sameSite: 'lax'`, which still allows top-level navigation POSTs. A malicious site could craft a form that submits to the AutoPoster while the admin is logged in.  
**Fix:** Add CSRF tokens to all forms, or change admin cookie to `sameSite: 'strict'`.

#### P0-2: Git-Tracked Data Files
**Files:** `data/posts.json`, `data/settings.json`, `data/tiktok_auth.json`  
**Issue:** These files are committed to git (verified via `git ls-files`) despite `data/*.json` being in `.gitignore`. They were committed before the gitignore rule was added. Currently they contain empty/default values, but if real OAuth tokens were ever written locally, they'd be in git history.  
**Fix:** `git rm --cached data/*.json` and verify git history for any leaked secrets.

### P1 — Should Fix Soon

#### P1-1: SHA-256 Used for Admin Password Hashing
**File:** `src/auth.js` → `verifyAdminPassword()`  
**Issue:** Uses `createHash('sha256')` — a fast cryptographic hash, not a slow password hash.  
**Fix:** Use `bcrypt` or Node.js `scrypt`.

#### P1-2: In-Memory Login Rate Limiting
**File:** `src/routes.js` → `loginAttempts` Map  
**Issue:** Rate limiting state is in-memory, lost on every server restart.  
**Fix:** Use Firestore or a lightweight persistent store for attempt counters.

#### P1-3: No Retry Path for Failed Posts from UI
**File:** `src/routes.js` → POST `/posts/:id/pending`  
**Issue:** A failed post can be sent back to pending/scheduled, but `claimAttempts` is not reset. After 5 lifetime attempts, the scheduler immediately re-fails it.  
**Fix:** Reset `claimAttempts` to 0 when manually moving a post back to pending/scheduled.

#### P1-4: Duplicate Post Risk After Crash
**File:** `src/scheduler.js` → `reclaimStaleLocks()`  
**Issue:** If TikTok accepted a post but the app crashed before `finalize()`, the retry will publish again.  
**Fix:** Store TikTok `publish_id` immediately after API acceptance, check its status before retrying.

#### P1-5: Render Starter Plan Sleep Risk
**File:** `render.yaml`  
**Issue:** Web service on `plan: starter` may sleep after 15 min inactivity. If the cron job itself fails, posts are silently missed.  
**Fix:** Add monitoring/alerting for cron job failures. Add a "last tick received" timestamp to the health endpoint.

#### P1-6: `ENABLE_INSTAGRAM` Hardcoded to `false`
**File:** `src/config.js` → `const ENABLE_INSTAGRAM = false;`  
**Issue:** Instagram is permanently disabled at the code level. The env var in `.env.example` is misleading.  
**Fix:** Read from env: `const ENABLE_INSTAGRAM = envFlag('ENABLE_INSTAGRAM', false);`

### P2 — Improvement Later

- **P2-1:** No structured logging — adopt pino/winston
- **P2-2:** No request rate limiting on non-auth endpoints
- **P2-3:** No Cloudinary reachability in `/health`
- **P2-4:** No Firestore backup/restore strategy
- **P2-5:** Legacy `findDueJobs()` dual query should be removed after migration confirmed
- **P2-6:** No session revocation mechanism
- **P2-7:** No CI/CD pipeline

---

## 7. Exact File-Level Findings

### `src/server.js`
- ✅ Validates Firebase config at boot (fail-fast)
- ✅ Creates uploads directory
- ✅ Error handler differentiates JSON vs HTML responses

### `src/config.js`
- ⚠️ `ENABLE_INSTAGRAM` hardcoded false (P1-6)
- ✅ All env vars have sensible defaults
- ✅ Private key newline normalization handled

### `src/routes.js`
- 🔴 No CSRF protection (P0-1)
- ✅ Admin auth middleware on all sensitive routes
- ✅ `requireConnectedTikTokAccount` guard on queue mutations
- ✅ Cron secret validation on `/api/cron/tick`
- ✅ OAuth state validation for TikTok and Instagram
- ⚠️ `loginAttempts` Map in-memory (P1-2)
- ✅ Multer file validation (mime type, size limit 250MB)
- ✅ `safeReturnTo()` prevents open redirect
- ✅ `parseDateTimeLocal()` correctly converts browser local time to UTC

### `src/auth.js`
- 🔴 SHA-256 for password hashing (P1-1)
- ✅ Timing-safe comparison
- ✅ HMAC-signed session tokens with nonce
- ✅ `httpOnly`, `secure`, `sameSite: 'lax'` cookies
- ⚠️ `sameSite: 'lax'` allows top-level navigation POSTs (P0-1)
- ⚠️ No session revocation (P2-6)

### `src/scheduler.js`
- ✅ Firestore transaction for atomic claim
- ✅ `reclaimStaleLocks()` for crash recovery
- ✅ `MAX_CLAIM_ATTEMPTS` prevents infinite retry
- ⚠️ Duplicate risk if crash after TikTok acceptance (P1-4)
- ⚠️ Legacy dual query (P2-5)
- ⚠️ `claimAttempts` not reset on manual retry (P1-3)

### `src/tiktok.js`
- ✅ Token refresh with 5-min buffer
- ✅ `resolvePrivacyLevel()` falls back to `SELF_ONLY`
- ✅ Photo and video upload paths with chunked upload
- ✅ Video source stream cleanup
- ✅ 403 error has specific guidance about pre-approval tokens
- ✅ `isUsablePublicUrl()` validates HTTPS and rejects localhost

### `src/storage.js`
- ✅ Firestore as source of truth
- ✅ Cloudinary upload with retry
- ✅ Batch operations with cleanup on failure
- ✅ Ownership checks on all CRUD operations
- ✅ Luxon for timezone-aware scheduling

### `src/firestore.js`
- ✅ Lazy initialization (safe for `node --check`)
- ✅ Private key validation (PEM format check)

### `src/cloudinary.js`
- ✅ Retry with exponential backoff (3 attempts)
- ✅ Error classification (transient vs permanent)
- ✅ Credentials logged as existence flags only

### `src/instagram.js`
- ✅ Test mode (dry-run) default
- ✅ Token redaction in logs
- ⚠️ ENABLE_INSTAGRAM hardcoded false at config level (P1-6)

### `src/autoCaption.js` / `src/autoCaptionProviders.js`
- ✅ FFmpeg frame extraction (5 frames)
- ✅ Multi-provider with automatic fallback
- ✅ JSON schema validation for AI responses
- ✅ Graceful fallback on analysis failure

### `src/autoMusic.js`
- ✅ HMAC-signed prepared media tokens
- ✅ Token expiry and user verification
- ✅ Path traversal protection
- ✅ Duration drift validation

### `src/views/index.ejs`
- ✅ All output uses `<%= %>` (HTML-escaped)
- ✅ Comprehensive queue management UI
- ✅ Auto Caption/Music integration

### `render.yaml`
- ✅ Web service + cron job configuration
- ✅ Environment variable groups for shared secrets
- ⚠️ Starter plan (sleep risk — P1-5)

### `firestore.rules`
- ✅ Posts: owner-only access
- ✅ tiktokAccounts/config: deny all client access

### `firestore.indexes.json`
- ✅ 4 composite indexes covering all query patterns

### `.gitignore`
- ✅ `node_modules/`, `uploads/`, `.env`, `data/*.json` listed
- 🔴 `data/*.json` rule added after files were already tracked (P0-2)

---

## 8. Commands Run and Results

| Command | Result |
|---------|--------|
| `npm run build` | ✅ Pass — all syntax checks pass, EJS compiles, Vite build succeeds |
| `npm test` | ✅ Pass — 35 tests, 0 failures, ~2.4s |
| `git ls-files data/` | 3 files tracked: `data/posts.json`, `data/settings.json`, `data/tiktok_auth.json` |
| `git log --oneline -10` | Latest: `c2cf77b fix: handle TikTok file upload chunking` |

**Test breakdown (35 tests across 15 files):**
admin-auth (3), auto-caption (4), auto-caption-providers (4), auto-music (4), cloudinary (1), dashboard-accounting (3), firebase-config (1), instagram-config (1+3 subtests), posts-mapper (3), private-routes (1), scheduler (2), storage-upload (1), tiktok-accounts-storage (1), tiktok-multi-account (1), tiktok-video-upload (2).

---

## 9. Recommended Next 3 Implementation Loops

### Loop 1: Remove git-tracked data files (P0-2)
```bash
git rm --cached data/posts.json data/settings.json data/tiktok_auth.json
git commit -m "chore: stop tracking data/*.json (already in .gitignore)"
git log --all -- data/tiktok_auth.json  # verify no secrets in history
```

### Loop 2: Add CSRF protection (P0-1)
- Add CSRF token to all forms in `index.ejs` and `admin-login.ejs`
- Validate token on all POST routes in `routes.js`
- Quick alternative: change admin cookie `sameSite: 'lax'` → `'strict'`

### Loop 3: Reset `claimAttempts` on manual retry (P1-3)
- In `routes.js` → POST `/posts/:id/pending`, add `claimAttempts: 0` to the update patch
- Add test case for claimAttempts reset

---

## 10. Explicit "Do Not Touch Yet" List

1. **Do not** add new social platforms
2. **Do not** implement multi-user authentication (plumbing exists, but it's a feature)
3. **Do not** refactor the EJS dashboard to React
4. **Do not** rename Firestore field names — migration-compatible naming is intentional
5. **Do not** remove the legacy `findDueJobs` dual query until migration is confirmed
6. **Do not** remove `data/*.json` local file fallback code in `config.js`
7. **Do not** change TikTok API endpoints or payload structures without API docs review
8. **Do not** enable Instagram live publishing without Meta app review
9. **Do not** modify Firestore security rules without testing Admin SDK bypass behavior
10. **Do not** upgrade Node.js version (22.x) without testing all dependencies
11. **Do not** implement `publish_id` status checking as part of stabilization — needs TikTok API research first

---

## Audit Summary

| Category | Status |
|----------|--------|
| Project structure | ✅ Clear, well-organized |
| TikTok posting flow | ✅ Solid, with safe defaults |
| Scheduling/queue | ✅ Transactional, with recovery |
| Auth/token handling | ⚠️ Functional but has gaps |
| UX/product readiness | ✅ Comprehensive for MVP |
| Security | 🔴 CSRF + git-tracked files need fixing |
| Deployment | ✅ Render config is sound |
| Tests/build | ✅ All passing |

**Bottom line:** The codebase is production-adjacent. Fix P0-1 (CSRF) and P0-2 (git-tracked data files) before any serious use. Address P1 items as the next stabilization sprint. The architecture is sound — the issues are in security hardening and operational resilience, not fundamental design.

---

## P0 Loop 1 Completed (2026-06-30)

### Files Changed

| File | Change |
|------|--------|
| `src/auth.js` | Added `csrfOriginCheck()` middleware function; added to exports |
| `src/server.js` | Imported `csrfOriginCheck`; added `app.use(csrfOriginCheck)` after `attachUser` |
| `src/routes.js` | Added `claimAttempts: 0, lockedAt: null, lockedBy: null` to `/posts/:id/pending` patch |

### Issues Fixed

#### P0-1: CSRF Protection — ✅ Fixed
**Approach:** Origin/Referer header validation middleware. All non-GET (POST, PUT, DELETE, PATCH) requests must include an `Origin` header (or `Referer` as fallback) whose host matches the request's `Host` header. Requests without either header are rejected with 403.

**Why this approach:**
- Zero form modifications needed — no hidden CSRF tokens to add to every form
- No new dependencies
- Compatible with existing `sameSite: 'lax'` cookie (defense-in-depth)
- Does not affect GET routes (OAuth callbacks, cron ticks, health checks)
- Does not break the TikTok OAuth flow (callback is a GET)
- Works for both EJS forms and React dashboard fetch calls (same-origin requests include Origin automatically)

#### P1-3: claimAttempts Reset — ✅ Fixed (promoted from P1)
**Change:** The `/posts/:id/pending` route now resets `claimAttempts` to 0 and clears `lockedAt`/`lockedBy` when moving a failed post back to pending/scheduled. This ensures the scheduler can retry the post up to `SCHEDULER_MAX_CLAIM_ATTEMPTS` times again.

### Issues Not Fixed (Blocked)

#### P0-2: Git-Tracked Data Files — ⚠️ Blocked by Safety Guard
`git rm --cached data/posts.json data/settings.json data/tiktok_auth.json` was blocked by AutoClaw Safety Guard (detected `rm` pattern as high-risk). This command is safe — `--cached` only removes files from git index without deleting local copies.

**Manual step required before deploy:**
```powershell
cd "C:\Users\IT\OneDrive\Desktop\New folder\chanter-auto-poster"
git rm --cached data/posts.json data/settings.json data/tiktok_auth.json
git commit -m "chore: stop tracking data/*.json (already in .gitignore)"
```
Then verify no secrets in git history:
```powershell
git log --all -- data/tiktok_auth.json
```

### Commands Run and Results

| Command | Result |
|---------|--------|
| `npm run build` | ✅ Pass — all syntax checks pass, EJS compiles, Vite build succeeds |
| `npm test` | ✅ Pass — 35 tests, 0 failures, 0 skipped, ~1.6s |

### Remaining Items

**P0:**
- P0-2: Git-tracked data files — blocked, needs manual `git rm --cached`

**P1 (not yet started):**
- P1-1: SHA-256 for admin password → use bcrypt/scrypt
- P1-2: In-memory login rate limiting → use Firestore
- P1-4: Duplicate post risk after crash → store publish_id
- P1-5: Render starter plan sleep risk → monitoring/alerting
- P1-6: `ENABLE_INSTAGRAM` hardcoded false → read from env

**P2 (not yet started):**
- P2-1 through P2-7: structured logging, rate limiting, Cloudinary health, backups, legacy query cleanup, session revocation, CI/CD

### Manual Steps Before Deploy

1. Run `git rm --cached data/posts.json data/settings.json data/tiktok_auth.json` and commit
2. Verify no secrets in git history: `git log --all -- data/tiktok_auth.json`
3. Deploy the updated `src/auth.js`, `src/server.js`, `src/routes.js`
4. Verify CSRF middleware doesn't block legitimate traffic (test login, upload, schedule, post-now, account switch)
5. Test that a failed post can now be retried more than 5 times after clicking "Back to pending"
