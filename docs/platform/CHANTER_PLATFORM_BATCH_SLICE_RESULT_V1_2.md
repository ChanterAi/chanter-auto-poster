# CHANTER Platform — Batch Slice Result V1.2
## Safe Delete Controls + Date-Range Scheduling + Daily Capacity/Slots + Multi-Account Fan-Out

Result date: 2026-07-23 (Asia/Nicosia)
Repository: `apps/chanter-auto-poster`, branch `main`
Baseline verified: `f838ecc` (V1.1, clean tree before work began — matched `origin/main`)
Final commit: pending push (see §9)
Mode: implementation + live operational verification against real Firestore/Cloudinary/Gemini and the real connected TikTok/YouTube channels; zero provider publishes; all test data deleted with zero residue.

## 1. Final verdict

**SHIPPED AND OPERATIONAL.** The batch intake surface now supports:

1. **Safe delete** — per-item `Διαγραφή` and batch-level `Διαγραφή παρτίδας`, both blocked on approved/terminal items, both reporting exact deleted/blocked/failed outcomes, both leaving zero residue when a batch is fully cleaned up.
2. **Three scheduling modes** — fixed interval (existing, generalized), date-range distribution (first day/last day + posts-per-day), and explicit daily slots (first day/last day + HH:MM list) — all channel-agnostic, capacity-bounded, deterministic, and DST-safe.
3. **Multi-account fan-out** — selecting 2+ connected TikTok accounts at intake creates one independent canonical post per (video × account), synchronized on one shared slot per source video by default, with fully independent edit/approve/delete/failure per destination copy.

YouTube remains reachable only through the existing per-item destination override in review (unchanged from V1.1) — it requires a human-entered title that cannot exist yet at bulk intake, so it is deliberately excluded from the intake-time multi-select. This is a stated, tested boundary, not a gap.

## 2. Implemented user flow (verified live, in order)

**Verification A — fan-out + date-range schedule** (real Firestore/Cloudinary/Gemini, 2 real connected TikTok accounts: `@oneday_with_u`, `@sphynxai0`):

1. Uploaded 2 disposable test videos, selected both accounts, mode "Εύρος ημερομηνιών" (date range), first/last day 2 days apart, 1 post/day at 11:00 Asia/Nicosia.
2. API created **4 canonical posts** (2 videos × 2 accounts) — confirmed `videoCount:2`, `destinationCount:2`, `itemCount:4`.
3. Both copies of video A scheduled at the identical `2026-07-25T08:00:00.000Z`; both copies of video B at `2026-07-26T08:00:00.000Z` — synchronized per source video, zero artificial per-account offset.
4. Review page (`/platform/autoposter/batches/:id`) rendered the new grouped layout live: "Βίντεο #1 · … · 2 προορισμοί" with one shared preview and two independent destination rows, each with its own caption/hashtags/state/Διαγραφή.
5. Real Gemini captioning completed for all 4 items independently (one item fell back to the local generator on a transient 503 — handled gracefully, not silently swallowed).
6. Edited **one** destination copy's caption only — sibling copy's caption confirmed unchanged.
7. Accepted **one** destination copy individually — sibling remained unapproved, its proposed slot unchanged.
8. Accepted the rest via Αποδοχή όλων — the group-aware re-stagger correctly kept both copies of the same source video on one shared final slot (`2026-07-25` pair identical, `2026-07-26` pair identical) even though acceptance happened across two separate calls.
9. All 4 items ended `approved:true`, `status:"scheduled"` — **never** `processing`/`posted`. **Zero provider publish calls.**
10. Cleanup: approval revoked on all 4, then whole-batch delete — `batchClosed:true`, zero Firestore residue, zero Cloudinary residue (verified both source assets return 404 after cleanup).

**Verification B — deletion + shared media safety** (separate disposable batch, 2 more real TikTok accounts: `@ai__sphynx`, `@__chanter`):

1. 1 video × 2 accounts → 2 destination copies, each with its **own independent Cloudinary asset** (confirmed distinct `cloudinaryPublicId`/URLs — this architecture never shares one upload across fan-out destinations, so cross-copy Cloudinary interference is structurally impossible, not just guarded against).
2. Deleted one unapproved copy — confirmed absent from the review view; confirmed its Cloudinary URL now returns **404** (asset actually destroyed); confirmed the sibling's Cloudinary URL still returns **200** (untouched, still playable).
3. Deleted the remaining item via whole-batch delete — `batchClosed:true`, batch view now `404 not_found`, batch absent from the list, final Cloudinary asset confirmed **404**.
4. Throughout: **zero provider publish calls**; the founder's real 5-item batch (`batch-b5b2529b…`) confirmed present and untouched before, during, and after both verifications.

## 3. Canonical data-model truth

- **`sourceIndex`** (new, batch-scoped, additive): stamped on every batch-linked post at creation — the position of its source video within the intake's file list. Every destination copy of the same video shares the same `sourceIndex`; non-batch/legacy posts keep it `null`. Guarded in `mapPatchToFirestore`'s closed allowlist exactly like `batchId`/`batchOrder`/`preparation` — a generic edit can never smuggle it (new focused test in `test/posts-mapper.test.js`).
- **`postBatches` schema, additive only**: `videoCount` (N), `destinationCount` (M), `scheduleMode`, `deletedCount` (atomic `FieldValue.increment`, immune to lost updates under concurrent per-item + whole-batch delete). `itemCount` keeps its existing self-correcting semantics (recomputed from live children on every `refreshBatchRecord`).
- **No shared canonical queue authority**: fan-out and delete both route through the exact same `posts` collection and the exact same `storage.deletePost`/`approvePost`/`changePostDestination` transactions V1/V1.1 already shipped. `batchService` adds only batch membership, the approval-lock delete gate, and bookkeeping — it never re-implements queue state.
- **Delete authority**: `storage.deletePost`'s existing transaction (state gates, usage release, Cloudinary reference-count-by-query cleanup) is reused unchanged. The one real gap it had — it does not check `approved` at all, since approval never changes queue `status` — is closed one layer up in `batchService.deleteItem`/`deleteBatch` (checked before the generic delete runs).
- **Scheduling**: `maxScheduler.computeBatchSchedulePlan` is a new, pure, channel-agnostic planner (interval/dateRange/dailySlots) returning per-source-video slots plus explicit `requiredSlots`/`availableSlots` for capacity-bounded modes. The pre-existing single-channel `computeBatchStaggerPlan` is untouched (still used by nothing new, kept only for backward-compatible test coverage).
- **Fan-out application**: `storage.applyBatchSourceSchedule` maps posts to slots **by `sourceIndex`**, many-to-one, unlike the strict 1:1 `applyStaggeredSchedule` it sits alongside — every destination copy of one source video receives the identical slot, with `channelOffsetMinutes:0` (no artificial per-account delay).
- **Multi-provider creation**: `batchService.createBatch` computes the schedule plan **once**, groups requested destinations by provider, and calls `applicationService.schedulePost` once per provider group under a new `schedule.mode:'batch_sync'` (validates a pre-built plan; never builds one itself). The `postBatches` record is reserved (`.create()`, fails loudly on duplicate) **before** any provider-group call; if a call throws, a compensating cleanup removes every post already created plus the reserved record, so a retry with the same `intakeKey` starts clean rather than duplicating copies.
- **Acceptance re-stagger is now group-aware**: `acceptItems` groups targets by `sourceIndex` (a legacy/non-batch item is its own singleton group — zero behavior change for V1/V1.1 single-destination batches), computes one safety-buffered slot per group, and applies it to every member — so synchronized fan-out slots survive the existing safety-buffer correction instead of drifting apart.
- **Intake boundary, stated honestly**: YouTube cannot be selected at batch intake (`provider_not_batchable`) because it requires a human-entered title that does not exist yet at bulk upload time; it remains reachable per item during review through the unchanged V1.1 `changeItemDestination` path.

## 4. Files changed (16 files: 13 modified, 3 new; +2,393/−208)

Modified: `src/maxScheduler.js` (+`computeBatchSchedulePlan`), `src/postsMapper.js` (`sourceIndex` projection + patch guard), `src/storage.js` (`sourceIndex` stamping, `applyBatchSourceSchedule`, `postBatches` schema, `incrementBatchDeletedCount`, `deleteBatchRecord`), `src/autoposterApplicationService.js` (`batch_sync` schedule mode), `src/batchService.js` (multi-destination `createBatch`, group-aware `acceptItems`, `deleteItem`/`deleteBatch`), `src/platformRoutes.js` (delete routes, intake body mapping, YouTube-excluded intake destination list), `src/views/platform-autoposter.ejs` (destination multi-select, 3 scheduling-mode UI, client-side capacity preview), `src/views/platform-batch.ejs` (grouped review rendering, per-item + batch delete), `public/platform/platform.css` (new component styles), `package.json` (build check chain), `test/platform-batch.test.js` / `test/platform-destination.test.js` (fixture contract updates for the new storage functions) / `test/posts-mapper.test.js` (new guard test).
New: `test/max-scheduler-batch-plan.test.js` (14 tests), `test/platform-batch-fanout.test.js` (9 tests), `test/platform-batch-delete.test.js` (6 tests), this report.

## 5. Tests, build

| Gate | Result |
|---|---|
| New V1.2 focused tests | **30/30 passed** — 14 scheduling-mode pure-function tests (interval/dateRange/dailySlots, capacity, DST gap, deterministic replay) + 9 fan-out tests (1×2, N×M, disconnected/YouTube-at-intake rejection, idempotent retry, partial-failure compensation, independent edit/approve/failure/delete) + 6 delete tests (eligible/idempotent/stale/approval-locked, whole-batch full + partial cleanup) + 1 patch-smuggling guard test |
| V1/V1.1 batch/scheduler suites re-run | **45/45 passed** (`platform-batch`, `batch-storage`, `platform-destination`, `max-scheduler`, `max-scheduler-routes`), updated only where the `createBatch` input contract legitimately changed (single `provider`/`accountId` → `destinations[]`) or where `'staggered'` scheduling was deliberately replaced by `'batch_sync'` — no assertion weakened |
| Full AutoPoster suite (`npm test`) | **470/470 passed, 0 failed** (440 baseline + 30 net new) |
| Build (`npm run build`: syntax-check every file, 9 EJS views compile, vite build) | **clean** |
| Live verification A (fan-out + date-range, real infra) | **PASS** — see §2 |
| Live verification B (deletion + shared media, real infra) | **PASS** — see §2 |

No existing test was weakened, skipped, or deleted. Where a test's literal input/output shape changed, it changed because the underlying contract intentionally changed (documented in §3), and the test now asserts the new, correct behavior.

## 6. Shared-media cleanup mechanism

Multi-account fan-out does **not** share one Cloudinary asset across destination copies: `storage.addUploadedPosts` already uploads once per (target account × source file) — a pre-existing loop this feature reuses unchanged, not a new upload path. Every destination copy therefore owns its own `cloudinaryPublicId`. This makes the two required invariants structurally trivial rather than merely enforced:

- *Delete one copy → siblings retain valid playable media* — true by construction (different `public_id`s); live-confirmed (§2, Verification B).
- *Delete the final referencing copy → the asset is destroyed exactly once, zero orphan residue* — `storage.deletePost`'s existing `limit(1)` reference-count-by-query check (unchanged) still correctly guards the (now purely theoretical, for fan-out) case of two posts sharing one `public_id`; live-confirmed via direct Cloudinary URL checks (404 after each delete).

## 7. Known limitations

1. Batch intake destinations are capped at 10 accounts (`MAX_DESTINATIONS`) and all must be the same class of provider that needs no upfront per-item metadata — today that means TikTok only. YouTube fan-out requires adding it per item in review after intake.
2. `computeBatchSchedulePlan`'s `dateRange` mode intra-day spacing (when no `dailyEndTime` is given) defaults to a fixed 60-minute interval; this is not yet operator-configurable from the UI (the field exists in the API).
3. Whole-batch delete processes items sequentially (matching `deleteMarkedPosts`'s existing bulk-delete philosophy), not as one multi-doc Firestore transaction — a partial result is reported honestly rather than rolled back, per spec intent, but a very large batch delete is not atomic end-to-end.
4. The `computeBatchStaggerPlan` (V1) single-channel planner is now dead code from the batch surface's perspective (superseded by `computeBatchSchedulePlan`'s `interval` mode) but was deliberately left in place, still tested, since nothing outside this feature depends on removing it and no test may be weakened.

## 8. Remaining blockers

None.

## 9. Push status

Committed to local `main`; see the accompanying commit for the exact hash. Push to `origin/main` follows immediately after this report is written, per the mission's execution loop.

## 10. Smallest next product step

Surface `computeBatchSchedulePlan`'s `dateRange`/`dailySlots` capacity numbers as a live server-confirmed preview (today the intake UI only mirrors the math client-side for instant feedback, matching the existing `maxScheduler` preview convention) before first upload, and let the operator configure `dateRange`'s intra-day interval instead of the fixed 60-minute default.
