# CHANTER Platform — Batch Slice Result V1.1
## Multi-Destination Review + Per-Item YouTube Title + Mixed-Destination Acceptance

Result date: 2026-07-23 (Asia/Nicosia)
Repository: `apps/chanter-auto-poster`, branch `main`
Baseline verified: `12e62f7` (clean tree before work began)
Mode: implementation + live operational verification against real Firestore/Cloudinary/Gemini and the real connected TikTok/YouTube channels; zero provider publishes; all test data deleted with zero residue.

## 1. Final verdict

**SHIPPED AND OPERATIONAL.** One batch can now carry different destinations per item: any item can be moved between connected TikTok channels and the connected YouTube channel during review, YouTube items carry a required per-item human title, and acceptance validates each item against its own destination before the existing human approval gate schedules it with the existing staggered/safety-buffer guarantees.

During live verification the V1 surface was found **in genuine founder use**: a real 5-item batch (real videos, 100-minute stagger) created through the Platform UI that morning was present in review, and was left untouched by this mission's verification and cleanup.

## 2. Implemented user flow (verified live, in order)

1. Upload 2 videos as one TikTok batch (45-minute stagger, first release 2026-07-26 11:00 local).
2. Review page shows per item: destination provider + channel, caption, hashtags, release slot, state chip, validation problems in Greek.
3. Item #2's destination selector lists all five real connected destinations (4 TikTok + YouTube @chantercy). Selecting YouTube reveals the required title field before anything is saved.
4. Saving with an empty title is refused with the provider-contract message («YouTube upload requires a non-empty title»); the item is untouched.
5. Saving with a human title + caption edit moves the item to YouTube @chantercy: `privacyStatus` locked to `private`, history `created → validated → prepared → destination_changed → edited`, staggered slot preserved.
6. Individual acceptance of the TikTok item, Accept All for the YouTube item — both through the existing `approvePost` human gate.
7. Post-acceptance provider truth (read raw from Firestore): TikTok item `publishAttemptBudget: null` (scheduler default), YouTube item `publishAttemptBudget: 1` — approval granted exactly one authorized claim; `claimAttempts: 0`, no locks, both `scheduled` for future slots. **Zero provider publish calls.**
8. Cleanup: only the test batch's 2 posts (Cloudinary assets destroyed via the existing delete path) and its `postBatches` record were deleted; residue confirmed zero; the founder's real batch confirmed intact (5 posts + record).

## 3. Canonical data-model truth

- **No new destination contract.** Destination identity remains the existing multi-field creation contract — `provider`, `platform`, `accountId`, `connectedAccountId`, `tiktokOpenId`, `username`, `providerMetadata` (bounded), `publishAttemptBudget` — written together by one new dedicated write path.
- **`storage.changePostDestination`** (transactional): refuses missing/foreign posts, terminal statuses, and — inside the transaction — approved items (`approval_locked`), so a stale review write can never move an accepted item. Records `destination_changed` (identity moved) or `edited` (title-only) history evidence.
- **Title preservation rule:** switching away from YouTube intentionally retains stored `providerMetadata` so a human-entered title survives a provider round trip; a later switch back re-validates it. TikTok paths never read it.
- **Generic patch surface hardened:** `mapPatchToFirestore` now strips `provider`, `platform`, `accountId`, `connectedAccountId`, `tiktokOpenId`, `username`, `providerMetadata`, `publishAttemptBudget` (verified: no existing caller patched them).
- **`applicationService.changePostDestination`** (website-only): provider registry gate (`assertSchedulableProvider`), canonical connected-account validation with workspace scoping (same path as intake), YouTube metadata contract via the existing `validateYouTubeMetadata` (title required, ≤100 chars, no `<>`), safe sanitized response.
- **No AI title generation** — the repository's explicit "never silently mapped from the caption" rule is preserved; titles are human-entered only, and preparation never touches them.
- **Acceptance re-validation:** `acceptItems` validates each item's own destination at the moment of acceptance (`validateConnectedAccount`, canonical + publishing-ready); a disconnected destination blocks only its own item with a precise reason. Stagger determinism, safety buffer (≥10 min future), per-item results, and the "completed only when ALL items accepted" summary rule are unchanged and re-proven.
- `postBatches` remains batch-level lifecycle/summary only.

## 4. Files changed (10 files, +1,529/−52, commit on `main`)

Modified: `src/postsMapper.js` (patch strip), `src/storage.js` (`changePostDestination`), `src/autoposterApplicationService.js` (`changePostDestination` op), `src/batchService.js` (`changeItemDestination`, `listDestinations`, title routing in `updateItem`, YouTube validation in `itemValidation`, destination re-validation in `acceptItems`), `src/platformRoutes.js` (destinations + destination endpoints, title passthrough), `src/views/platform-batch.ejs` (destination selector, conditional title field, per-item blocker reporting), `package.json` (checks), `test/platform-batch.test.js` (publishing-ready fixture).
New: `test/platform-destination.test.js` (11 tests), `docs/platform/` (this report + the relocated V1 report).

## 5. Tests, build

| Gate | Result |
|---|---|
| New V1.1 focused tests (`test/platform-destination.test.js`) | **11/11 passed** — destination persistence/refusals, patch smuggling strip, title contract + human precedence + preservation, switch-before-preparation, mixed Accept All (stagger + buffer across providers), disconnected-destination partial acceptance + honest summary + idempotent repeat, stale-write approval lock |
| V1 batch suites re-run | **18/18 passed** |
| Full AutoPoster suite (`npm test`) | **440/440 passed, 0 failed** |
| Build (node --check all, 9 EJS views compile, vite) | **clean** |

No test was weakened or deleted. The only fixture change gave the test TikTok account real token/scope fields, because acceptance now legitimately verifies publishing readiness.

## 6. Known limitations

1. Batch **intake** still targets one TikTok channel; YouTube enters via per-item override in review (a batch-wide YouTube intake would require per-item titles at upload time — deferred deliberately).
2. Item destination changes are review-surface features for unapproved drafts; approved items require approval revocation first (existing classic-console flow).
3. The YouTube description field exists in the contract and API but is not surfaced in the review UI (title only) — kept calm; add on demand.
4. Live verification stopped, by design, at approved+scheduled with zero provider calls; an actual private YouTube upload through a batch-switched item remains exercised only by the existing provider-path test suite.
5. Duplicate-media warnings are computed at intake against the original channel; moving an item to another channel does not re-run duplicate detection.

## 7. Remaining blockers

None.

## 8. Smallest next product step

Surface the founder's real in-review batch workflow end-to-end: a batch list state chip on `/platform/autoposter` for "awaiting review" plus optional per-item YouTube description editing — both pure additions to the existing review surface.
