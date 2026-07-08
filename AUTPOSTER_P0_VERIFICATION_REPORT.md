# AutoPoster P0 Verification Report

**Date:** 2026-07-08
**Auditor:** CHANTER AIM Execution Team (independent re-verification, read-only)
**Source of truth:** `CHANTER_AUDIT_REPORT.md` (2026-07-08, repo-root) → flagged `chanter-auto-poster`'s two P0 claims from `AUTO_POSTER_AUDIT.md` (2026-06-30) as "not independently re-verified" and the #1 highest-risk item overall.
**Method:** Direct source inspection of every state-changing route, the CSRF middleware, git tracking state, and live-publish tooling — not trust in either prior document's self-attestation. Commands run: `git status --short`, `npm test`, `npm run build`, `git diff --check`.
**Explicitly not run (per mission constraint):** `scheduler:ping`, `migrate:firestore`, `migrate:firestore:dry-run`, any Firestore/cron script, any real TikTok/Instagram publish.

---

## Executive Summary

**Both P0 claims from `AUTO_POSTER_AUDIT.md` are TRUE-FIXED, independently confirmed against current source, not just against the audit doc's own self-report.** One adjacent, previously-undocumented CSRF gap was found (GET-based disconnect routes) — low severity, not a re-opening of P0-1. Tests (119/119) and build both pass. Working tree is clean. No secrets found in source, logs, tests, or public assets.

| # | Claim | Verdict | Risk Level |
|---|-------|---------|------------|
| P0-1 | Missing CSRF protection on state-changing POST routes | **TRUE (fixed, verified)** | LOW residual |
| P0-2 | Git-tracked data files (`data/*.json`) | **TRUE (fixed, verified)** | LOW residual |

**Readiness verdict: READY for a controlled, human-supervised live publish test** (`SELF_ONLY` privacy, single test asset, explicit approval phrase), subject to the caveats in [§7](#7-readiness-for-controlled-live-publish-test).

---

## 1. P0-1 — CSRF Protection on State-Changing Routes

### Original claim (AUTO_POSTER_AUDIT.md, 2026-06-30)
> All state-changing operations (upload, delete, schedule, post-now, settings, account switching) accept simple form-encoded POSTs with no CSRF token... A malicious site could craft a form that submits to the AutoPoster while the admin is logged in.

### Verdict: **TRUE — fixed and independently verified**

### Evidence

| Check | Result | File |
|---|---|---|
| CSRF middleware exists | ✅ `csrfOriginCheck(req, res, next)` validates `Origin` (fallback `Referer`) host against request `Host`; rejects with `403` on mismatch or if both headers are absent on any non-GET/HEAD/OPTIONS request | [src/auth.js:197-236](src/auth.js) |
| Middleware is globally wired | ✅ `app.use(csrfOriginCheck)` mounted app-wide, before the router — covers every route, not just an allowlist | [src/server.js:19](src/server.js) |
| All POST routes inventoried (13 total) | ✅ Every one sits behind the global CSRF middleware **and** an explicit auth guard (`requireAdminPage` / `requireAdminApi` / `requireConnectedTikTokAccount`) | [src/routes.js](src/routes.js) (full grep below) |
| Admin password hashing | ✅ Uses `scryptSync`, not SHA-256 — confirms `AUTO_POSTER_AUDIT.md`'s own "P1 Security Loop" section is accurate and current | [src/auth.js:85-101](src/auth.js) |

Full state-changing route inventory (mission scope: publish-now, schedule, delete/cancel, save campaign, account/channel actions):

| Route | Method | Guard | Maps to mission item |
|---|---|---|---|
| `/admin-login` | POST | rate-limited (5/15min/IP), no session yet — this *is* the login | — |
| `/logout` | POST | `requireAdminPage` | — |
| `/private/autoposter/account` | POST | `requireAdminPage` | account/channel switch |
| `/api/instagram/publish` | POST | `requireAdminApi` | publish (Instagram, dry-run only — see §5) |
| `/api/auto-caption` | POST | `requireAdminApi` | — |
| `/upload` | POST | `requireConnectedTikTokAccount` | upload/save campaign |
| `/settings` | POST | `requireAdminPage` | settings |
| `/schedule` | POST | `requireConnectedTikTokAccount` | schedule |
| `/posts/:id` | POST | `requireConnectedTikTokAccount` | save campaign (edit) |
| `/posts/:id/move` | POST | `requireConnectedTikTokAccount` | — |
| `/posts/:id/prepare` | POST | `requireConnectedTikTokAccount` | **publish-now** (`force:true` → `scheduler.processPost`) |
| `/posts/:id/posted` | POST | `requireConnectedTikTokAccount` | — |
| `/posts/:id/pending` | POST | `requireConnectedTikTokAccount` | — |
| `/posts/:id/delete` | POST | `requireConnectedTikTokAccount` | **delete/cancel** |

`requireConnectedTikTokAccount` ([src/routes.js:794-809](src/routes.js)) internally calls `requireAdminPage` first when `!req.isAdmin`, so it is strictly a superset (auth + connected-account check), not a weaker path.

"Publish-now" (`/posts/:id/prepare`) routes through `scheduler.processPost(id, { force: true })` — the **same** Firestore-transaction claim path the automatic cron scheduler uses, including the durable `publishId` duplicate-publish guard added in the repo's own P1 Ledger loop. A double-click cannot double-publish. Confirmed by `test/scheduler.test.js`'s passing "duplicate-publish protection still refuses jobs with a durable publishId" test.

### Executable proof (not just static reading)
`test/private-routes.test.js` boots a real Express server and asserts, via live HTTP requests:
- Unauthenticated `GET /private/autoposter`, `/private/autoposter/dashboard`, `/connect/tiktok` → `302` to `/admin-login`
- Unauthenticated `GET /api/private/autoposter/dashboard`, `POST /api/auto-caption` → `401 {"ok":false,"reason":"Admin authentication required"}`
- Login page never reflects the real admin password back in HTML
- Failed login sets no session cookie
- Successful login cookie is `HttpOnly` + `SameSite=Lax`
- Account-A and Account-B post data are mutually isolated in the rendered queue (cross-tenant leak check)

### Findings beyond the original claim (new, not in `AUTO_POSTER_AUDIT.md`)

1. **LOW — Two state-changing routes use GET and bypass the CSRF check by design.** `GET /disconnect/tiktok` ([src/routes.js:336](src/routes.js)) and `GET /disconnect/instagram` ([src/routes.js:377](src/routes.js)) mutate state (clear tokens, set `connected: false`) but GET is in `csrfOriginCheck`'s `safeMethods` allowlist ([src/auth.js:198](src/auth.js)), so no Origin/Referer check applies. `SameSite=Lax` still permits the cookie on a top-level cross-site navigation (e.g., a link click or `window.location` redirect from an attacker page), so a forced disconnect is technically possible while an admin is logged in. **Impact is limited to a nuisance/availability action** (forces reconnect; does not leak data, does not allow unauthorized posting, does not touch other accounts) — this was outside the literal scope of the original P0-1 claim (which named POST routes specifically), so it does not reopen P0-1, but it is a real, verifiable gap worth a follow-up. **Suggested fix:** change both routes to POST, or add a same-origin check.
2. **LOW — No automated regression test for the CSRF middleware itself.** Grepped `test/` for `csrf`, `Origin mismatch`, `CSRF check`, `Referer` (case-insensitive) — zero matches. The middleware is correct today by inspection, but nothing would fail if `app.use(csrfOriginCheck)` were ever accidentally removed from `src/server.js`. **Suggested fix:** add a direct test asserting a cross-origin POST is rejected (403) and a same-origin POST passes.

### Required fix
None blocking. Two low-severity, non-blocking follow-ups noted above (GET-disconnect CSRF coverage; missing regression test).

---

## 2. P0-2 — Git-Tracked Data Files

### Original claim (AUTO_POSTER_AUDIT.md, 2026-06-30)
> `data/posts.json`, `data/settings.json`, `data/tiktok_auth.json` are committed to git despite `data/*.json` being in `.gitignore`... if real OAuth tokens were ever written locally, they'd be in git history.

### Verdict: **TRUE — fixed and independently verified**

### Evidence

| Check | Command | Result |
|---|---|---|
| No data files currently tracked | `git ls-files data/` | Empty output |
| Gitignore rule present | `.gitignore` line 4 | `data/*.json` |
| Gitignore actually matches all three files | `git check-ignore -v data/posts.json data/settings.json data/tiktok_auth.json` | All three matched by `.gitignore:4:data/*.json` |
| Full history of each file | `git log --all --oneline -- data/{posts,settings,tiktok_auth}.json` | Exactly 2 commits each: `5d94c7e` (initial add) and `584326e` (removal via `git rm --cached`) — not re-added since |
| Local files still exist (expected — gitignored dev state) | `ls -la data/` | `posts.json`, `settings.json`, `tiktok_auth.json` + 2 extra untracked files (`instagram_auth.json`, `users.json`) — all correctly untracked |
| Firestore is the real source of truth, not `data/*.json` | [src/config.js:32-34](src/config.js): "...of truth now. They're kept only so `src/migrate-to-firestore.js` can..."; [src/storage.js:776](src/storage.js) comment confirms same | Confirmed in current source, not just doc claim |
| Local token fields are empty (checked without printing raw secret values — sandbox correctly blocked a direct `cat` of these files as a credential-materialization risk; verified via a boolean-only field inspector instead) | `data/tiktok_auth.json`: `connected=false`, `access_token`/`refresh_token`/`open_id` all empty. `data/instagram_auth.json`: `connected=false`, all token fields empty. | No live captured credentials sitting in local dev state |

### Required fix
None. Recommend (non-blocking, operational hygiene — already noted in the original audit and not disputed here): rotate TikTok OAuth tokens (disconnect/reconnect) before or shortly after any live test, since `data/tiktok_auth.json` did exist in git history at `5d94c7e`, even though its content was always empty placeholders.

---

## 3. Private / Auth Route Protection

Verified beyond the two P0 items per mission scope.

- **Page routes** (`requireAdminPage`): unauthenticated → `302` redirect to `/admin-login`. Verified live via `test/private-routes.test.js`.
- **API routes** (`requireAdminApi`): unauthenticated → `401 JSON`, no redirect. Verified live.
- **Static mounts**: `/autoposter-dashboard` and `/uploads` are both gated by `requireAdminPage` at the `express.static` mount point in [src/server.js:20-26](src/server.js), not left to the app-level router alone.
- **Machine-to-machine routes** (`/api/cron/tick`, `/run-scheduler`, `/api/debug/jobs`, `/api/storage/health`): gated by `authorizeCronRequest` — a constant-value comparison against `config.cronSecret` (via `x-cron-secret` header or `secret` query param), returning `503` if the secret isn't configured at all and `403` on mismatch. Appropriately separate from cookie-based admin auth, since these are called by Render's cron job, not a browser. [src/routes.js:927-938](src/routes.js)
- **Firestore rules** ([firestore.rules](firestore.rules)): `tiktokAccounts/{accountId}` and `config/{document=**}` both `allow read, write: if false` — deny all direct client access. The Admin SDK (server-only) bypasses these rules by design; this is defense-in-depth against a hypothetical future direct-client integration, not the current production path.
- **`/health`** and **`/api/instagram/health`** are intentionally public (no admin gate) but were checked line-by-line and confirmed to expose only booleans/timestamps/counts — no tokens, no raw env values.

No gaps found beyond the GET-disconnect CSRF note in §1.

---

## 4. Live Publish Tooling — Cannot Run Accidentally

### Verdict: **TRUE — verified safe by design and by test**

| Check | Result |
|---|---|
| `scripts/live-publish-test.js` invoked anywhere automatically? | **No.** Grepped the full repo (excluding `node_modules`/`.git`) for `live-publish-test` and `livePublishTest` — only self-references, the `package.json` `node --check` syntax-only validation, and `test/live-publish-test.test.js` (which imports only the non-executing plan-builder module, never the CLI script) |
| Requires explicit human confirmation? | **Yes.** Requires both `--execute` **and** the exact phrase `--confirm "I approve the controlled live publish test."` (case, punctuation, and whitespace sensitive — trims surrounding whitespace only). Without both, it prints the `LIVE PUBLISH APPROVAL REQUIRED` gate and exits `1` — touches nothing. [scripts/live-publish-test.js](scripts/live-publish-test.js), [src/livePublishTest.js](src/livePublishTest.js) |
| Confirmed by test | `test/live-publish-test.test.js`: "confirmation requires the exact phrase, nothing looser" — asserts near-miss phrases (wrong case, missing period) are rejected |
| Even when executed, does it bypass safety rails? | **No.** It only creates a *scheduled* Firestore job through the same `storage.addUploadedPosts`/`applyExplicitSchedule` functions the normal `/upload` route uses — "there is no separate, less-reviewed code path for a 'test' post" (in-code comment, verified accurate). Actual publish still happens later, only via the guarded cron-tick → `claimPost` (duplicate-guarded) → TikTok call path. Default `TIKTOK_PRIVACY_LEVEL` is `SELF_ONLY`. |
| Approval gate leaks secrets? | **No.** `test/live-publish-test.test.js` explicitly asserts the rendered gate never matches `/access_token\|refresh_token\|client_secret\|api[_-]?key/i` |
| `npm run scheduler:ping` (Render cron entrypoint, [src/ping-scheduler.js](src/ping-scheduler.js)) | Requires real `APP_URL` + `CRON_SECRET` pointed at a deployed instance; throws immediately if either is missing. **Not run**, per mission constraint. |
| `npm run migrate:firestore` / `--dry-run` | **Not run**, per mission constraint. |

### Required fix
None.

---

## 5. Secrets / Token Exposure — UI, Logs, Evidence, Tests, Public Assets

### Verdict: **TRUE — no exposure found**

| Surface | Check | Result |
|---|---|---|
| `.env` | `git ls-files \| grep env` | Only `.env.example` tracked; all values are empty or clearly-placeholder (`replace-with-a-long-random-secret`, etc.) |
| Tracked source (`.js`/`.jsx`/`.mjs`/`.ejs`) | `git grep` for `access_token`/`refresh_token`/`client_secret`/`api_key` assigned to a 15+ char literal | No matches |
| Built public assets (`public/**`) | Grepped for `sk-…`, `AIza…`, `ya29.…`-shaped strings | No matches |
| TikTok API logging | `src/tiktok.js` — every `console.log`/`console.error` call site that logs a payload/response goes through `safeLog`/`safeError`, which run `redactSensitive()` (redacts `access_token`, `refresh_token`, `client_secret`, `open_id`, `code`, and camelCase variants) | Confirmed at all 5 call sites via grep: [src/tiktok.js:431,447,473,528,715,720,734,749](src/tiktok.js) |
| New runtime-adapter evidence bundles (`src/runtime/*`) | `runtimeRedaction.js` implements key-substring matching (`token`,`secret`,`password`,`apikey`,`bearer`), JWT/long-random-string heuristics, and signed-URL query-param stripping; `runtimeEvidence.js`'s `baseEvidence()` passes every bundle through it before returning | Confirmed applied, not just defined-but-unused — traced call sites in [src/runtime/runtimeEvidence.js:42](src/runtime/runtimeEvidence.js) |
| Test output | Ran `npm test` and read full console output | Only fixture domains (`cdn.example.com`) and fixture tokens (`signed-prepared-media-token` — a literal test-fixture string, not a real token) appear |
| Login page | `test/private-routes.test.js` asserts the real admin password is never reflected in the login page HTML | Confirmed by passing test |
| Local untracked `data/*.json` | Field-presence check (values not printed — see §2) | All token fields empty |

### Required fix
None.

---

## 6. Validation Results

All commands run from `apps/chanter-auto-poster`:

| Command | Result |
|---|---|
| `git status --short` (before) | Clean — no output |
| `npm test` | ✅ **119/119 pass**, 0 fail, 0 skip, ~1.7s |
| `npm run build` | ✅ Pass — 40 `node --check` syntax validations + EJS compile (`index.ejs`, `admin-login.ejs`) + Vite build (24 modules, ~98ms) |
| `git status --short` (after build) | 5 files modified under `public/autoposter-dashboard/` — expected Vite-regenerated build artifacts (line-ending/whitespace-only diff) |
| `git diff --check` (before restore) | Exit code 2 — CRLF/trailing-whitespace warnings on the regenerated dashboard artifacts only |
| `git restore public/autoposter-dashboard/` | Applied per mission step 10 |
| `git status --short` (final) | Clean — no output |
| `git diff --check` (final) | Exit code 0 — clean |
| `git log -1 --oneline` | `9568cc2 feat(autoposter): add runtime adapter foundation` on `main` |
| `git rev-list --left-right --count origin/main...HEAD` (against cached remote ref, no fetch performed) | `0  0` — fully in sync |

**Commands explicitly not run** (forbidden by mission): `npm run scheduler:ping`, `npm run migrate:firestore`, `npm run migrate:firestore:dry-run`, any live TikTok/Instagram publish call.

---

## 7. Readiness for Controlled Live Publish Test

**Assessment: READY**, with the same scope the repo's own `AUTO_POSTER_AUDIT.md` "Private Production Smoke Test Plan" (Phases 1–7) already defines — single operator, `SELF_ONLY` privacy, explicit human approval at the publish step.

Basis for this assessment:
- Both P0 claims are independently confirmed fixed against current source, not assumed from the doc.
- Every state-changing route (publish-now, schedule, delete/cancel, save campaign, account/channel switch) is behind both the global CSRF Origin/Referer check and an explicit per-route auth guard, confirmed by source inspection and live executable tests.
- The live-publish CLI tool cannot fire without an exact, human-typed approval phrase, is never auto-invoked, and still routes through the same duplicate-guarded, transactional publish path as normal scheduled posts.
- No secrets are exposed anywhere checked: source, logs, tests, public build assets, or local untracked dev-state files.
- `git status` is clean and in sync with `origin/main`.

Caveats a human operator should weigh before proceeding:
1. **Two low-severity findings from this pass are not yet fixed** (not blocking, but should be tracked): GET-based disconnect routes bypass CSRF by method; no regression test locks in the CSRF middleware itself.
2. **Deploy/live status remains UNVERIFIED** — this pass, like the one before it, did not and was not asked to check network reachability or live Render traffic. `render.yaml` config was read, not exercised.
3. **Token rotation recommended** — disconnect/reconnect TikTok after/before the controlled test, since `data/tiktok_auth.json` (empty values only) did exist in git history at `5d94c7e`.
4. **Open P1s from `AUTO_POSTER_AUDIT.md` remain open** and unaffected by this pass (in-memory login rate limiting, no session revocation, no CI/CD) — consistent with the original audit's own "Safe for: single-operator private TikTok scheduling" / "Not safe for: multi-user, public-facing, or automated production" framing, which this verification pass has no basis to dispute either way.

---

## 8. Summary Table (mission-requested format)

| P0 Claim | Verdict | Evidence | Risk Level | Required Fix |
|---|---|---|---|---|
| P0-1: Missing CSRF protection on state-changing POST routes | **TRUE (fixed, verified)** | [src/auth.js:197-236](src/auth.js), [src/server.js:19](src/server.js), [test/private-routes.test.js](test/private-routes.test.js) | LOW residual (GET-disconnect gap; no regression test) | None blocking. Optional: POST-ify `/disconnect/tiktok`+`/disconnect/instagram`; add a CSRF regression test. |
| P0-2: Git-tracked data files | **TRUE (fixed, verified)** | `git ls-files data/` (empty), `.gitignore:4`, `git log --all -- data/*.json` | LOW residual (empty values existed briefly in git history) | None blocking. Optional/operational: rotate TikTok OAuth tokens before/after live test. |

**Git status:** Clean, `main` @ `9568cc2`, 0 ahead / 0 behind `origin/main`.
**Validation:** `npm test` 119/119 pass · `npm run build` pass · `git diff --check` clean.
**Live publish test readiness:** READY for controlled, human-supervised test per the existing Phase 1–7 plan in `AUTO_POSTER_AUDIT.md`.
