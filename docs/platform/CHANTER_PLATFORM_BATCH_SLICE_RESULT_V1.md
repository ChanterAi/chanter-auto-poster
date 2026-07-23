# CHANTER Platform — Batch Intake Product Slice Result V1

Result date: 2026-07-23 (Asia/Nicosia)
Repository: `apps/chanter-auto-poster` (branch `main`)
Commit: `12e62f7` — pushed to `origin/main` (`833b4d8..12e62f7`)
Mode: full implementation + live operational verification against real Firestore/Cloudinary/Gemini; zero publishes; all test data deleted after verification.

## 1. Verdict

**SHIPPED AND OPERATIONAL.** The first usable CHANTER Platform product slice is implemented, tested, live-verified in the browser, committed, and pushed:

Unified Platform Shell → AutoPoster Module → Massive Upload / Batch Intake → AI Preparation → Human Review → Staggered Scheduling.

## 2. What is now operational

- `GET /platform` — Greek-first CHANTER Platform shell (admin session; same auth/CSRF as the classic console).
- `GET /platform/autoposter` — batch module: drag-drop multi-video upload, channel select (real connected TikTok channels), first-release date/time, stagger interval, recent-batches list.
- `GET /platform/autoposter/batches/:batchId` — review surface: per-item video preview, editable caption/hashtags/release slot, item state chips, validation problems in plain Greek, per-item Αποδοχή, Αποδοχή όλων, resume-preparation, live polling while preparing.
- Batch items ARE ordinary queue posts (drafts). The classic Release Queue, scheduler, approval gate, history evidence, duplicate warnings, and provider paths see them natively — one data model, no duplicated canonical state.

## 3. Exact user flow (verified live, in order)

1. Open `/platform`, enter AutoPoster module.
2. Upload 3 videos in one batch (real multipart intake → Cloudinary assets → Firestore posts + `postBatches` record).
3. Items created as **unapproved drafts** with staggered proposed slots (10:00 / 10:30 / 11:00 local, 30-min stagger).
4. Bounded-parallel preparation ran automatically: per-item Cloudinary download → FFmpeg frames → **real Gemini captions/hashtags per item** (OpenAI transcription quota-exceeded was skipped gracefully — the documented fallback).
5. Edited item #1's caption by hand; history shows `created → validated → prepared → edited`.
6. Accepted item #1 individually (`approvedBy: admin:owner`; siblings untouched).
7. Accept All approved the remaining 2; batch reached `completed`, counts 3/3 accepted.
8. Classic dashboard API showed the same three jobs `scheduled + approved` — boundary intact.
9. Nothing published: no in-process cron exists; slots were 2 days in the future; the safety buffer re-staggers past slots at acceptance.
10. Cleanup: all 3 test posts deleted via the existing delete API (Cloudinary assets destroyed), test `postBatches` record deleted, 0 residue confirmed.

## 4. Architecture of the slice

- **Items = posts.** New fields `batchId`, `batchOrder`, `preparation` (closed-allowlist projection in `postsMapper.js`; generic website patches cannot smuggle them — `mapPatchToFirestore` strips them).
- **New `postBatches` collection** holds only batch-level lifecycle + count summary; items remain the durable truth.
- **New schedule mode `staggered`** in `autoposterApplicationService.schedulePost`, backed by pure `computeBatchStaggerPlan` in `maxScheduler.js` (single-channel, per-item stagger — previously only per-channel stagger existed). Entitlement/usage authorization, media validation, account validation, and workspace scoping all reuse the existing paths byte-for-byte.
- **Preparation engine** (`batchService.js`): bounded concurrency (default 2), per-item transactional lease claims (`claimBatchItemPreparation` / `recordBatchItemPreparationResult` in `storage.js`, mirroring `claimPost`'s shape), attempt budget (default 3), stale-lease reclaim (default 10 min), resume-on-view + explicit resume endpoint. Preparation fills caption/hashtags **only where empty** — human edits always win.
- **Acceptance** (`acceptItems`): requires an explicit human approver context; walks targets in release order and guarantees every accepted slot ≥ now + safety buffer (default 10 min) and ≥ previous slot + stagger; then routes through the existing `approvePost` human gate. Nothing is ever pulled earlier; nothing publishes immediately.
- **Config**: new `batchIntake` block in `config.js` (all bounds env-tunable, fail-closed defaults).
- **v1 boundary, stated honestly:** batch intake targets TikTok channels; YouTube keeps its per-video flow (it requires a per-video title the batch surface will not invent).

## 5. Files changed (16 files, +3293/−3)

New: `src/batchService.js`, `src/platformRoutes.js`, `src/views/platform.ejs`, `src/views/platform-autoposter.ejs`, `src/views/platform-batch.ejs`, `public/platform/platform.css`, `test/platform-batch.test.js`, `test/batch-storage.test.js`.
Modified: `src/autoposterApplicationService.js` (staggered mode, batchId passthrough), `src/storage.js` (batch stamping, staggered apply, batch records, claim/record), `src/postsMapper.js` (batch projection + patch guard), `src/maxScheduler.js` (stagger planner), `src/firestore.js` (postBatches), `src/config.js` (batchIntake), `src/server.js` (mount), `package.json` (build checks + EJS compile list).

## 6. Validation evidence

| Gate | Result |
|---|---|
| New batch tests (service + transactional storage) | **18/18 passed** |
| Full AutoPoster suite (`npm test`) | **429/429 passed, 0 failed** |
| Build (`npm run build`: node --check all files, EJS compile all 9 views, vite) | **clean** |
| Live browser E2E (real Firestore/Cloudinary/Gemini) | full flow §3 verified |
| Regression to existing AutoPoster workflows | none (full suite green; classic queue verified live) |

One real defect was found by the new tests and fixed before commit: `Number(null) === 0` coercion would have given every legacy post `batchOrder: 0` instead of `null`.

## 7. Functional gates from the mission

- Batch upload works — verified live (3 videos, one batch).
- Multiple items persist correctly — Firestore posts + batch record; replay-idempotent intake (deterministic batchId from intakeKey).
- Preparation resumes after interruption — stale-lease reclaim proven in tests; resume endpoint + resume-on-view live.
- Item-level status visible — state chips + validation problems in Greek, per item.
- Failed items do not corrupt the batch — isolation proven in tests (`attention_required`, siblings acceptable).
- Individual edits persist — verified live with history evidence.
- Accept All performs a real approval transition — verified live (`approvedAt`/`approvedBy` via existing `approvePost`).
- Scheduling produces staggered future jobs — verified live (30-min stagger) and in tests (re-stagger of past slots).
- No item publishes immediately — safety buffer + approvedAt gate + no local cron; `providerPublishCalls: 0` throughout.
- Existing approval boundaries enforced — untouched `claimPost`/`approvePost`/scheduler code paths.

## 8. Known limitations

1. Batch intake is TikTok-only in v1 (YouTube needs per-item titles; single-video flow remains).
2. Intake idempotency is batch-record-based: a crash after post creation but before the batch record commits would leave visible, deletable orphan drafts (flagged by the existing duplicate warning on retry) — honest failure, no hidden state.
3. `Screenshot` capture of the review page hangs the browser-pane capture pipeline (embedded Cloudinary `<video>` elements); evidence captured as page text + API JSON instead.
4. The platform surface uses the existing single admin session (multi-tenant identity remains the known AutoPoster-wide P1 from the 2026-07-22 audit — out of this slice's scope).
5. Root workspace docs (`CHANTER_SYSTEM_INDEX.md`) still predate this slice; this report is the current truth for it.

## 9. Smallest next product step

Per-item destination override in review (move one item to another connected channel before acceptance), then YouTube batch support via a per-item title field in the review surface — both pure additions to `batchService.updateItem`/`acceptItems` with no new authority.
