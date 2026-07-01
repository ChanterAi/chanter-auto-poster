# CHANTER Auto Poster Premium-Readiness Audit

**Audit date:** 2026-07-01

**Scope:** Current repository state on `main` at `12b3b11`; posting, scheduler, Firestore queue, auth/accounts, dashboard UX, tests, and deployment contracts.

**Change policy:** Documentation-only audit. No runtime code, TikTok behavior, Firestore data, environment values, or deployed services were changed.

## A. Executive Verdict

**Current product state: Not Ready** for a premium production claim.

The app is a substantial private advanced MVP with several good foundations: server-side admin sessions, Firestore persistence, per-account token records, Cloudinary-backed media, transactional job claims, external cron triggering, token refresh, legacy-data compatibility, and broad mocked test coverage. It should not be represented as premium-ready until live TikTok completion, scheduler health, and retry behavior are made truthful and verified in production.

- **Biggest blocker:** TikTok init/upload acceptance is immediately finalized as Firestore `posted`. The app does not call TikTok's publish-status endpoint or consume a status webhook, so `posted` does not prove that TikTok reached `PUBLISH_COMPLETE`. TikTok's current guidance says clients should poll publish status or handle status webhooks so users can understand the real outcome.
- **Biggest quick win:** Make scheduler health truthful without changing publishing: count overdue canonical `scheduled` jobs, count only genuinely stale `processing` jobs, surface Firestore query failure as degraded, and test those exact semantics.
- **Biggest production risk:** A process crash after TikTok accepts media but before Firestore stores `publishId`/final state leaves a stale `processing` job that is resubmitted. That can create a real duplicate TikTok post.

### Readiness by area

| Area | Verdict | Evidence |
|---|---|---|
| Upload and media persistence | Mostly ready in code | MIME/size limits, Cloudinary persistence, cleanup, and fallback behavior exist and are tested. No live Cloudinary upload was run in this audit. |
| Caption and scheduling | Mostly ready in code | Caption/hashtags persist, local time is converted to an absolute Firestore timestamp, and due jobs are queried canonically. Unsaved edits can still be bypassed by `Post now`. |
| TikTok Direct Post | Not ready for a premium claim | Official API endpoints are used and token refresh/chunking are covered, but final publish status and several required consent/disclosure rules are not enforced end to end. |
| Queue and worker | Partially ready | Firestore transactions prevent simultaneous claims, but transient retry/backoff, durable tick health, and full stuck-job recovery are missing. |
| Auth and accounts | Suitable for one private operator | Signed `httpOnly` admin session and per-account Firestore tokens exist. Rate limiting is in-memory; sessions are not revocable; disconnect is a state-changing GET. |
| Dashboard and UX | Functional but not premium | Jobs/accounts are readable and failures appear, but state coverage is incomplete, controls are visibly inert, refresh is manual, and the dashboard styling diverges from the dark main product. |
| Deployment | Reproducibility gap | The Blueprint defines paid `starter` web plus cron services, but omits required Firebase and TikTok variables. Actual Render settings and live cron execution were not available for verification. |

### Positive contracts to preserve

- Firestore remains the scheduled-job source of truth.
- New jobs use canonical `status: scheduled` plus Firestore `scheduledAt`; legacy `pending/scheduledTimeUTC` reads remain compatible.
- Scheduler claims use Firestore transactions with `lockedAt`, `lockedBy`, and `claimAttempts`.
- Jobs are bound to stable TikTok account identifiers and ambiguous legacy jobs fail closed.
- TikTok tokens are server-side and log redaction is present.
- Cloudinary, not Render-local disk, is the durable media store for new uploads.
- Default configured privacy is `SELF_ONLY`; this audit does not change that behavior.

## B. Critical Issues

### 1. TikTok acceptance is recorded as completed posting

- **Severity:** Critical
- **Files:** `src/tiktok.js:184-227`, `src/tiktok.js:732-781`, `src/scheduler.js:355-413`, `src/routes.js:922-962`, `src/pages/AutoPosterDashboard.jsx:258-270`, `test/p1-ledger.test.js:86-140`, `test/p1-reliability.test.js:92-99`
- **Why it matters:** Video init/upload and photo init are asynchronous TikTok operations. The current publisher returns `ok: true` after init/upload, and `finalize()` immediately writes `status: posted`. Tests explicitly treat a response containing `status: PROCESSING_UPLOAD` as a completed success. A rejected or failed asynchronous TikTok processing step can therefore appear as posted. The main page partially says “Posted / API accepted,” but Firestore and the control room use the terminal `posted` state.
- **Recommended fix:** In a dedicated, heavily tested TikTok loop, persist `publishId` immediately and move the job to a nonterminal state such as `accepted`/`processing_remote`. Reconcile via TikTok `POST /v2/post/publish/status/fetch/` or an approved webhook until `PUBLISH_COMPLETE` or terminal failure, then finalize. Preserve existing endpoints and payload behavior until this is proven with mocked contract tests and a private live post.
- **Risk of changing it:** High. It changes queue-state semantics and TikTok lifecycle handling. It needs backward-compatible normalization for existing `posted` records and must not resubmit already accepted jobs.

Official references: [TikTok Direct Post API](https://developers.tiktok.com/doc/content-posting-api-reference-direct-post), [TikTok Get Post Status](https://developers.tiktok.com/doc/content-posting-api-reference-get-video-status), and [TikTok Direct Post UX guidelines](https://developers.tiktok.com/doc/content-sharing-guidelines/).

### 2. Crash recovery can duplicate an accepted post

- **Severity:** Critical
- **Files:** `src/scheduler.js:184-230`, `src/scheduler.js:232-280`, `src/scheduler.js:355-413`, `src/tiktok.js:184-227`, `src/tiktok.js:732-781`
- **Why it matters:** `publishId` is written only during `finalize()`. If TikTok accepts the request and the process dies before that transaction, the job remains `processing` without a durable remote identifier. Stale-lock recovery changes it back to `scheduled`, and the next tick submits it again. The current duplicate guard only protects jobs whose `publishId` was already stored.
- **Recommended fix:** Solve together with issue 1: persist the remote publish identifier at the earliest safe point, never reclaim a job with a known remote identifier into a resubmission path, and reconcile remote status before retrying. Add a crash-injection test between remote acceptance and Firestore finalization.
- **Risk of changing it:** High. Incorrect recovery logic can either duplicate content or permanently strand legitimate jobs.

### 3. Retry and stuck-job handling are incomplete

- **Severity:** High
- **Files:** `src/scheduler.js:75-143`, `src/scheduler.js:184-230`, `src/scheduler.js:355-413`, `src/config.js:54-63`
- **Why it matters:** Any normal API/network failure is immediately terminalized as `failed`; there is no retry classification, `nextAttemptAt`, backoff, or retry audit trail. Recovery only queries `processing` documents with an old `lockedAt`, so legacy/corrupt `processing` jobs with missing `lockedAt` remain stuck. A stale-lock recovery error is appended to the tick response but does not set `summary.ok = false`.
- **Recommended fix:** Add explicit retryable/nonretryable classification, bounded backoff, and `nextAttemptAt` while retaining the current claim transaction. Add a separate safe repair path for `processing` documents missing lock metadata. Never automatically retry a job that may already have been accepted remotely until issue 1 is solved.
- **Risk of changing it:** High. Retry changes can increase TikTok traffic and duplicate risk unless remote acceptance is reconciled first.

### 4. Health can report green while Firestore or scheduling is unhealthy

- **Severity:** High
- **Files:** `src/scheduler.js:13-72`, `src/scheduler.js:94-115`, `src/routes.js:197-211`, `render.yaml:18-20`
- **Why it matters:** `/health` always returns HTTP 200 and `ok: true`. `getSchedulerHealth()` swallows Firestore query errors, labels every in-flight `processing` job as stale regardless of age, and checks overdue jobs only through the legacy `pending/scheduledTimeUTC` shape—not canonical `scheduled/scheduledAt`. `lastTickAt` is process-local and resets on restart, so it cannot prove durable cron continuity. Render's configured health check cannot detect these failures.
- **Recommended fix:** First safe patch: correct the read-only health queries and return a structured `degraded` reason when Firestore cannot be checked. Persist a token-free scheduler heartbeat in Firestore later. Decide separately whether degraded health should return 503, because that can affect Render restart behavior.
- **Risk of changing it:** Low if limited to additional truthful fields and tests; Medium if HTTP status codes are changed.

### 5. TikTok disclosure and required consent controls are not honored end to end

- **Severity:** High
- **Files:** `src/views/index.ejs:820-941`, `src/routes.js:568-593`, `src/tiktok.js:408-426`, `src/tiktok.js:649-680`, `src/storage.js:474-493`
- **Why it matters:** The UI stores `contentDisclosure`, `yourBrand`, and `brandedContent`, but neither photo nor video payload maps them to TikTok's `brand_organic_toggle` and `brand_content_toggle`. The UI also automatically selects a privacy option and checks available interaction controls by default. Current TikTok guidelines require the user to manually select privacy, manually opt into interaction settings, and prevent commercial disclosure from proceeding without a selected type. TikTok's current video API reference lists both brand toggles in `post_info`.
- **Recommended fix:** Treat this as a proven provider-contract bug, but implement it only in a dedicated TikTok compliance patch. Add payload tests for both photo and video, preserve `SELF_ONLY` as the safe configuration fallback, and make the UI validation match the provider rules without silently changing existing stored records.
- **Risk of changing it:** High. This alters TikTok request payloads and consent UX and therefore requires provider-contract tests and a private live smoke test.

Official references: [TikTok Direct Post API fields](https://developers.tiktok.com/doc/content-posting-api-reference-direct-post) and [TikTok Direct Post UX guidelines](https://developers.tiktok.com/doc/content-sharing-guidelines/).

### 6. “Post now” can publish stale caption, privacy, and disclosure values

- **Severity:** High
- **Files:** `src/views/index.ejs:796-958`, `src/routes.js:559-630`
- **Why it matters:** Edit controls are in one form and `Post now` is a separate form. If the operator changes title, hashtags, schedule, privacy, interaction, disclosure, or media URL and clicks `Post now` without first clicking `Save`, the scheduler loads the previous Firestore record. The confirmation only says the schedule is ignored; it does not warn that unsaved edits are ignored.
- **Recommended fix:** Small UI/route patch: make Post Now save and validate the displayed post settings in the same request before attempting the transactional claim, or block Post Now while the edit form is dirty and clearly require Save. Add a route test proving the published object contains the displayed values.
- **Risk of changing it:** Medium. Combining save and publish must not create a race or accidentally change an already-processing job.

### 7. Render Blueprint is not a complete production contract

- **Severity:** High
- **Files:** `render.yaml:1-66`, `.env.example:1-68`, `src/server.js:54-79`, `src/config.js:114-128`
- **Why it matters:** `render.yaml` omits Firebase credentials and TikTok OAuth variables even though startup fails without Firebase and TikTok cannot connect without its client configuration. A fresh Blueprint deployment is therefore incomplete unless values are added manually in Render. The repository cannot prove that `APP_URL`, the custom-domain callback, shared `CRON_SECRET`, deployed indexes, or current live service state match the code.
- **Recommended fix:** Document every required variable in the Blueprint as `sync: false` without values, keep generated/shared secrets in the environment group, and add a non-secret preflight checklist. Verify deployed Render settings manually; do not print values.
- **Risk of changing it:** Medium. Blueprint edits can modify live service configuration on sync; review Render's plan before applying.

Render note: the Blueprint uses paid `plan: starter`. Current Render documentation says paid instance types do not spin down; the 15-minute idle spin-down applies to Free instances. The remaining reliability dependency is cron execution and application recovery, not normal Starter-plan sleep. References: [Render Free instances](https://render.com/docs/free), [Render FAQ](https://render.com/docs/faq), and [Render cron jobs](https://render.com/docs/cronjobs).

### 8. Dashboard state coverage and controls are incomplete

- **Severity:** Medium
- **Files:** `src/pages/AutoPosterDashboard.jsx:10-18`, `src/pages/AutoPosterDashboard.jsx:235-299`, `src/pages/AutoPosterDashboard.jsx:303-527`, `src/pages/AutoPosterDashboard.css:1-450`, `src/storage.js:232-261`
- **Why it matters:** Status controls omit `pending`, `ready`, and any future retry/accepted states. The page is titled “Scheduled posts” while it renders all jobs. Retry, Cancel, Delete, and Post Now buttons are shown but permanently disabled. Refresh is manual, no job-age/stuck indicator exists, and `logs` normally has no event source. A failed job is visible, but the operator is not given a clear, working recovery path from this dashboard. The light control-room theme also conflicts with the established dark main app.
- **Recommended fix:** First remove or clearly separate inert controls. Then show every normalized state, last transition time, overdue/stuck reason, next action, and automatic refresh with a visible freshness timestamp. Keep the dashboard read-only until mutation endpoints have explicit authorization and tests.
- **Risk of changing it:** Low for presentation-only changes; Medium if action endpoints are introduced.

### 9. Auth/session behavior is adequate for one operator, not premium multi-user operation

- **Severity:** Medium
- **Files:** `src/auth.js:43-77`, `src/auth.js:107-177`, `src/routes.js:25-28`, `src/routes.js:135-168`, `src/routes.js:254-304`, `src/routes.js:685-725`
- **Why it matters:** Login throttling is in memory and resets on restart or across instances. Signed sessions cannot be revoked before expiry. TikTok disconnect is a state-changing GET, so the non-GET origin check does not protect it. OAuth state and active-account cookies do not explicitly set `secure`. The active-account selection falls back to the first connected account, then the first stored account, which is convenient but should be made explicit before true multi-user use.
- **Recommended fix:** Before multi-user work, make disconnect a POST, add explicit cookie security settings, store rate limits/session version server-side, and preserve deterministic account ownership. Keep the existing simple admin gate for the current private product until a real auth project is explicitly approved.
- **Risk of changing it:** Medium. Cookie/session changes can log out the operator or break OAuth callbacks if proxy handling is wrong.

### 10. Documentation, schema, and verification have drifted

- **Severity:** Medium
- **Files:** `ARCHITECTURE.md`, `AUTO_POSTER_AUDIT.md`, `README.md`, `src/scheduler.js`, `src/postsMapper.js`, `render.yaml`, `package.json`
- **Why it matters:** `ARCHITECTURE.md` still describes older fields/statuses and an in-process cron recommendation that the current server no longer uses. The previous audit says Render Starter sleeps, which current Render documentation contradicts. There is no lint script or CI workflow. Unit tests are broad but heavily mocked; they do not prove live Firestore indexes, Render cron, Cloudinary, OAuth, TikTok final status, or duplicate-free crash recovery.
- **Recommended fix:** After reliability behavior is settled, replace contradictory operational text with one canonical architecture/runbook, add CI for `npm test` and `npm run build`, and add contract tests around final status, disclosure, health semantics, and dirty-form Post Now.
- **Risk of changing it:** Low for documentation/tests; Medium if stale migration compatibility is removed based only on documentation.

### 11. Compatibility code and unclear operational ownership increase maintenance cost

- **Severity:** Low
- **Files:** `src/scheduler.js:145-179`, `src/storage.js:166-198`, `src/storage.js:695-732`, `src/auth.js:179-185`, `src/scheduler.js:145-148`, `src/tiktok.js:52-54`
- **Why it matters:** Legacy due-job queries and singleton TikTok auth lazy migration remain active indefinitely. Exported helpers such as `requireUser`, `publishNextPost`, and `isConfigured` have no current caller. Compatibility is valuable, but without a retirement condition it makes queue behavior harder to reason about and test.
- **Recommended fix:** Add telemetry or a read-only migration report first. Remove compatibility paths only after confirming no production documents depend on them. Delete truly unused exports in a separate low-risk cleanup.
- **Risk of changing it:** Low for confirmed dead exports; High if legacy reads are removed before production data is inspected.

### 12. Production dependency audit has unresolved moderate findings

- **Severity:** Medium
- **Files:** `package.json`, `package-lock.json`
- **Why it matters:** `npm audit --omit=dev` reports eight moderate vulnerabilities through the Firebase Admin dependency chain (`uuid`, `gaxios`, `google-gax`, `@google-cloud/firestore`, `@google-cloud/storage`, `retry-request`, and `teeny-request`). The reported all-findings remediation would install `firebase-admin@10.3.0`, which is a breaking downgrade from the current major version and is not a safe automatic fix.
- **Recommended fix:** Review current compatible Firebase Admin/transitive releases and upstream advisory status in a dedicated dependency patch. Run the full test/build suite and Firestore smoke after any lockfile change. Do not use `npm audit fix --force` blindly.
- **Risk of changing it:** Medium to High. Firebase Admin version changes can alter credential, Timestamp, Firestore, and Storage behavior.

## C. Premium Upgrade Roadmap

### Loop 1: Stability/reliability

1. Correct scheduler health semantics and tests without changing publish behavior.
2. Add durable, token-free cron heartbeat and alert thresholds for missed ticks, overdue scheduled jobs, and stale processing locks.
3. Design TikTok remote lifecycle states and status reconciliation; add mocked API contract tests first.
4. Persist remote publish identifiers before any retry path and add crash-injection duplicate tests.
5. Only then add bounded retry classification/backoff for transient failures.
6. Verify Firestore composite indexes and a five-minute scheduled post in the deployed environment.

Exit criteria: no false-green health, no accepted-as-complete label, no retry without remote reconciliation, and a documented recovery path for every nonterminal state.

### Loop 2: Dashboard clarity

1. Show all real states: unscheduled, scheduled, processing/local, accepted/remote, posted, failed, retrying, and legacy/unassigned.
2. Add scheduled age, last transition, last tick freshness, account, privacy, attempt count, and human-readable next action.
3. Remove inert action buttons or keep the view explicitly read-only.
4. Add safe auto-refresh with “last updated” and degraded/stale banners.
5. Keep raw technical details inside the existing expandable diagnostics area and redact sensitive values.

Exit criteria: an operator can tell what happened, whether action is required, and whether the data is fresh without opening Render or Firestore.

### Loop 3: Premium UX polish

1. Resolve dirty-form Post Now behavior and add destructive-action confirmation for Delete/Disconnect.
2. Keep account identity, destination privacy, and exact media visible immediately before publish consent.
3. Align the control room with the clean dark CHANTER product system; reduce duplicated metrics/filters and keep mobile readability.
4. Add upload/publish busy states that prevent duplicate submission without faking success.
5. Improve empty states for “no account,” “no scheduled jobs,” “all posted,” and “failed jobs need action.”

Exit criteria: no ambiguous button, no stale-data publish, no fake control, and no state conveyed only by color.

### Loop 4: Caption/hashtag assistant readiness

1. Preserve the existing provider-neutral/manual fallback contract; do not add models during stabilization.
2. Add deterministic length/empty validation against the final combined TikTok title text.
3. Show generated/manual provenance and never overwrite operator edits without confirmation.
4. Add contract tests proving AI failure leaves a valid manual caption path and never schedules corrupted/blank output unexpectedly.
5. Keep caption assistance isolated from upload, scheduler, credits, auth, and TikTok publishing.

Exit criteria: assistant output is editable, bounded, attributable, and never blocks the manual path.

### Loop 5: Multi-account/history readiness

1. Keep stable `open_id`/account ownership as the identity source; never infer ownership from username.
2. Scope settings and scheduler operations explicitly per account before exposing multi-user behavior.
3. Require owner/account checks inside `processPost`, not only at the route layer.
4. Add append-only lifecycle events for queue history instead of relying on a mutable `lastResult` plus an usually-empty `logs` field.
5. Define token revocation, reconnect, account removal, and historical-job behavior before auth expansion.
6. Do not destructively migrate legacy jobs; retain the explicit Legacy / Unassigned presentation.

Exit criteria: every mutation is user/account scoped, every historical transition is explainable, and ambiguous legacy data stays fail-closed.

## D. Safe First Patch Recommendation

**Single safest first patch:** make `getSchedulerHealth()` truthful and add focused tests, without changing any TikTok request, queue transition, endpoint contract, or Firestore document.

Patch boundary:

- Count overdue canonical jobs with `status == scheduled` and `scheduledAt <= now`.
- Count stale processing jobs using the configured lock threshold, not all processing jobs.
- Report a structured degraded/error field when Firestore health queries fail instead of silently returning zero.
- Keep `/health` HTTP 200 in the first patch to avoid changing Render restart behavior; review a later 503 policy separately.
- Add tests for canonical overdue, active processing versus stale processing, and Firestore query failure.

Why first: it improves observability of missed/stuck jobs, does not alter posting or privacy, and gives the later reliability work a trustworthy operational signal.

**Not implemented in this audit.**

## E. Test Plan

### Local commands

Run from the repository root in PowerShell:

```powershell
npm ci
npm test
npm run build
git diff --check
```

There is currently no `lint` script. Add lint only as a separate tooling patch; do not hide that absence by calling syntax checks “lint.”

Optional non-mutating checks:

```powershell
npm audit --omit=dev
rg -n "publish/status|status/fetch|brand_content_toggle|brand_organic_toggle" src test
```

Production/operator checks require approved credentials and must never print secret values:

```powershell
curl.exe -sS https://poster.chanterr.com/health
curl.exe -sS -H "x-cron-secret: $env:CRON_SECRET" "$env:APP_URL/api/debug/jobs"
curl.exe -sS -H "x-cron-secret: $env:CRON_SECRET" "$env:APP_URL/api/storage/health"
```

Do not run `npm run scheduler:ping` against production until all due jobs are reviewed; it can trigger real publishing. Do not run `migrate:firestore` during this audit.

### Manual smoke tests

Use a dedicated private TikTok test account, a clearly marked short test asset, and `SELF_ONLY` unless a human explicitly approves otherwise.

1. **Upload media**
   - Log in through `/admin-login` and confirm the private app/dashboard are inaccessible when logged out.
   - Select the intended TikTok account and upload one supported image, then one short supported video.
   - Confirm Cloudinary-backed HTTPS media, preview, caption, hashtags, account identity, and correct Firestore job ownership.
   - Confirm a failed upload is human-readable and creates no false-success job.

2. **Post Now**
   - Save caption/privacy first under the current UI contract.
   - Confirm the destination account, privacy, media, and consent text.
   - Trigger Post Now once; double-click/replay the request and confirm only one Firestore claim.
   - Treat current `posted` as API acceptance only until TikTok status reconciliation exists.

3. **Schedule 5 minutes ahead**
   - Set a time five minutes ahead in the browser's local timezone.
   - Confirm Firestore stores an absolute Timestamp and status `scheduled`.
   - Confirm the UI renders the same intended local time after reload.

4. **Confirm Firestore job status**
   - Before due time: `scheduled`, `scheduledAt`, account IDs, privacy, media URL, and zero claim attempts.
   - During claim: `processing`, one `lockedBy`, recent `lockedAt`, incremented attempt count.
   - After remote confirmation is implemented: nonterminal accepted state followed by terminal `posted` only on `PUBLISH_COMPLETE`.

5. **Confirm TikTok result**
   - Verify the item on the intended TikTok account and verify its privacy.
   - Compare TikTok result/publish identifier with the Firestore record.
   - Record whether TikTok completed, failed processing, or remained pending; API acceptance alone is not completion.

6. **Confirm failed job display**
   - Use a controlled non-destructive failure such as an invalid test media URL or disconnected test account.
   - Confirm main queue and control room show Failed, a human-readable reason, account, attempt count, and an honest recovery instruction.
   - Confirm no raw stack trace, token, secret, or full sensitive response appears.

7. **Confirm no duplicate posting**
   - Send overlapping cron ticks and a Post Now request for the same due job; confirm one transactional claim.
   - Repeat after a stored `publishId`; confirm the job is skipped.
   - After status reconciliation is built, inject a crash after remote acceptance but before local finalization and confirm recovery polls status instead of resubmitting.

8. **Cron/Render recovery**
   - Confirm Render cron logs run at the configured cadence and web logs show matching `[CRON_TICK]` markers.
   - Restart/redeploy the web service with a future scheduled job and confirm the Firestore job/media/token state survives.
   - Confirm the next tick recovers overdue work and that health reports the interruption honestly.

### Audit validation results

These results are filled from this documentation-only audit run:

| Command | Result |
|---|---|
| `npm test` | **Passed:** 51 tests, 0 failed, 0 skipped, duration 1560.7539 ms. External providers were mocked; no real post was made. |
| `npm run build` | **Passed:** Node syntax checks, EJS compilation, and Vite 8.0.16 production build; 24 modules transformed in 184 ms. Generated tracked assets had no content changes. |
| `npm audit --omit=dev` | **Failed:** exit 1; 8 moderate vulnerabilities in the Firebase Admin transitive dependency chain. The proposed force fix is breaking and was not applied. |
| `git diff --check` | **Passed:** exit 0. Git emitted existing LF-to-CRLF warnings for generated dashboard assets; no tracked asset content changed. |
| Lint | Not available: `package.json` has no `lint` script. |
| Live TikTok/Firestore/Render smoke | Not run; would require production credentials and can trigger a real post. |

## F. No-Regression Checklist

- [ ] Existing upload works for supported photo and video media.
- [ ] Existing Post Now works through the transactional claim path.
- [ ] Existing schedule works with canonical Firestore `scheduledAt`.
- [ ] Existing TikTok OAuth, refresh, disconnect, and reconnect behavior works.
- [ ] Existing public/private posting behavior is preserved; no silent visibility escalation.
- [ ] Existing account/job binding remains deterministic and legacy jobs remain fail-closed.
- [ ] Existing Cloudinary media persistence and local cleanup remain intact.
- [ ] Existing Firestore indexes and legacy read compatibility remain intact.
- [ ] Existing admin/private route protection remains intact.
- [ ] No secrets, tokens, OAuth codes, private keys, or sensitive response bodies are exposed.
- [ ] No destructive Firestore migration or mass rewrite is performed.
- [ ] No accepted TikTok request is reported as final completion without evidence.
- [ ] No retry path can resubmit a remotely accepted post without reconciliation.

## Known Audit Limitations

- No production environment values, Render dashboard, Firestore console, Cloudinary account, or TikTok account were inspected.
- No live OAuth, upload, Post Now, schedule, cron, provider callback, or duplicate/crash smoke was executed.
- The audit validates repository contracts and current official provider/platform documentation, not the live deployment.
- Existing unit tests use mocks for external services; passing them cannot establish production readiness.
- No Vercel configuration exists in this repository. The current frontend is server-rendered EJS plus Vite assets served by Express; any separate Vercel/DNS/proxy configuration is outside this checkout and remains unverified.

## Audit Conclusion

Do not build large new product features yet. Complete Loop 1 in small patches, beginning with truthful read-only scheduler health. The current architecture does not need a rewrite, but premium readiness requires that remote publishing state, retry safety, and operator-visible health reflect reality rather than API acceptance.
