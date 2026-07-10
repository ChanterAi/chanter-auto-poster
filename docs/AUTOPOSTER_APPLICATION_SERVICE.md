# AutoPoster Application Service

## Status and scope

The Phase 0 audit found one real Firestore `posts` queue and one real media
policy, but no shared product-operation layer. Website, client-portal, and P1B
Runtime controllers each coordinated storage directly. The canonical boundary
for that coordination is now:

```text
src/autoposterApplicationService.js
```

This boundary is TikTok-only. It does not add an Instagram, YouTube, LinkedIn,
or generic provider integration. It does not activate the older P1A
`src/runtime/` mapping adapter; that adapter remains pure, read-only, and
outside the active P1B control path. None of these application operations
publishes content or calls a provider. Scheduler claiming and the existing
TikTok publishing boundary remain separate and unchanged.

Part 1 is additive: no Firestore migration, destructive backfill, UI redesign,
push, deployment, or live publishing is part of this work.

## Phase 0 gap map

| Classification | Confirmed repository truth | Consolidation rule |
| --- | --- | --- |
| **AUTHORITATIVE** | Firestore `posts`, `storage.js` ownership-aware reads/writes and queue construction, `postsMapper.js`, `mediaPolicy.js`, and the scheduler's transactional approval/claim checks are the current truth. | Orchestrate these modules; do not replace them. |
| **DUPLICATED** | Admin `/upload`, client upload, and P1B Runtime `/schedule` independently resolved accounts, validated timestamps, created jobs, and applied schedules. Queue/status projections and retry-reset patches also existed in more than one controller. | Route all supported product actions through the application service while leaving transport/rendering concerns in controllers. |
| **ROUTE-EMBEDDED** | Browser routes selected active/all queue scope, resolved multi-channel plans, performed media checks, and assembled bulk-delete truth. Runtime routes separately owned bounded listing, status views, explicit-time validation, idempotency lookup, and create-then-schedule behavior. | Controllers authenticate, build context, translate input/output, and render; the service owns the product operation. |
| **STORAGE-EMBEDDED** | `addUploadedPosts` owns media persistence/fallback, campaign child construction, duplicate warnings, initial approval, and the stored job shape. `updatePost`, `autoSchedulePosts`, `applyExplicitSchedule`, and `reschedulePendingQueue` own existing scheduling writes. | Keep low-level persistence in storage. The service coordinates these primitives and reports partial failure truthfully. |
| **TIKTOK-SPECIFIC** | Account identity uses TikTok account/open-id fields, new intake is video-only, and current jobs default to `platform: "tiktok"`. | Make the current contract explicit as `platform: "tiktok"` and `provider: "tiktok"`; reject other providers. Do not build provider abstractions in Part 1. |
| **SAFE TO CONSOLIDATE** | Queue listing, status, media validation, scheduling, approval/revocation, deletion, bulk deletion, the existing manual retry/reset, and existing queue rescheduling all have reusable primitives. | Expose only these real operations through `autoposterApplicationService.js`. |
| **OUT OF SCOPE** | Provider integrations, workspace tenancy, subscriptions, UI changes, auth replacement, scheduler/provider publishing changes, automatic approval, migration, and activation of the P1A adapter. | Keep these dormant or unchanged. |

The highest-risk pre-consolidation gap was Runtime idempotency: it used a
read-then-create lookup and applied the schedule in a later write. The shared
service now gives an idempotent single-channel request a deterministic post ID
and uses Firestore create-only support so concurrent creates converge on one
queue document. Explicit Runtime/client schedules, source, approval, and
idempotency metadata are included in that initial write, eliminating the
pending-item replay window. Existing automatic and Max scheduling modes still
use their established storage primitives after creation; any partial count is
reported truthfully with the visible draft IDs.

## Execution context

Every operation accepts a structured context, normalized by
`createExecutionContext`:

```js
{
  userId,          // authenticated queue owner; never trust a request-body override
  actorId,         // human or runtime actor for audit metadata; defaults to userId
  accountId,       // TikTok channel scope; may be empty only for operations that allow all owned channels
  source,          // "website" | "runtime" | "internal_worker"
  correlationId,  // caller trace/correlation identifier when available
  workspaceId,     // optional reserved slot; workspace tenancy is not implemented
  approval: { approvedBy } | null,
  idempotency: { key }
}
```

Context rules:

- `userId` comes from the authenticated website/client session or the
  server-side Runtime token mapping, never from an untrusted payload.
- `accountId` is rechecked against the owner's TikTok accounts by operations
  that require a channel.
- `workspaceId` is accepted only as a future-compatible slot. It is not an
  authorization boundary, is not persisted as tenancy proof, and must not be
  presented as implemented multi-tenancy.
- A Runtime schedule requires an idempotency key and cannot use context
  approval to self-approve. Website approval is honored only when it represents
  the existing explicit human action.
- `correlationId`, `actorId`, and source are audit metadata, not authority.

## Canonical operations

All signatures are semantic `operation(context, input)` contracts. HTML/JSON
response shaping stays outside this module.

| Operation | Existing behavior preserved |
| --- | --- |
| `listQueue(context, { accountId?, limit? })` | Checks optional owned-account scope, applies a bounded limit, returns items, counts, total-in-scope, and scope without treating an empty queue as a storage error. |
| `getPostStatus(context, { postId, accountId? })` | Uses owner/account-scoped `storage.getPost`; missing and non-owned posts retain the same non-probing not-found result. |
| `validateMedia(context, input)` | Delegates acceptance to `mediaPolicy.js`; TikTok remains video-only and public URLs remain HTTPS plus MP4/MOV/WebM only. |
| `schedulePost(context, input)` | Resolves owned connected accounts, validates media and the existing automatic/explicit/browser-local/Max modes, plus the already-supported human-confirmed live-test plan, creates through `addUploadedPosts`, and schedules through existing storage primitives. It never publishes. |
| `approvePost(context, { postId, accountId?, approvedBy? })` | Reuses the existing reviewable-status approval write. Approval records permission; it does not publish. |
| `revokeApproval(context, { postId, accountId? })` | Clears the existing approval fields only for reviewable jobs, preserving fail-closed worker behavior. |
| `deletePost(context, { postId, accountId? })` | Preserves ownership scope and returns the actual storage deletion truth. |
| `deleteMarkedPosts(context, { postIds, accountId? })` | Deduplicates and bounds the selection, calls `deletePost` for every item, and returns separate `deleted` and `failed` results. |
| `retryPost(context, { postId, accountId? })` | Extracts the already-supported manual reset: clears result/lock/attempt fields and returns the job to `scheduled` or `pending`. It is not worker stale-lock reclaim and does not publish. |
| `rescheduleQueue(context, { accountId? })` | Wraps the existing owner/channel-scoped pending-queue rescheduler. It adds no new scheduling algorithm. |
| `updatePost(context, input)` | Preserves the existing owner/account-scoped queue edit, normalizes browser-local schedule input with `timeUtil.js`, and rejects invalid timestamps instead of silently changing product state. |
| `markPostManually(context, { postId, accountId? })` | Preserves the explicit human-only "marked posted" evidence transition; it records no API publish and checks the underlying update result. |

`storage.updatePost` remains the low-level persistence helper used by typed
application operations. `updatePost` is consumed only by the existing website
edit controller; no Runtime route or MCP tool exposes a generic patch surface.
The controlled internal live-test plan keeps its existing zero-minute buffer:
due-now timestamps have a 60-second hand-off grace, while older plans fail
closed before any queue item is created.

## Canonical queue-item contract

There is still one queue: the existing Firestore `posts` collection. New writes
through the service use the existing stored shape plus additive metadata:

| Field group | Canonical meaning |
| --- | --- |
| Identity | `id`, `userId`, `accountId`, TikTok account display/open-id fields |
| Provider | `platform: "tiktok"`, `provider: "tiktok"` |
| Origin/audit | `creationSource`, `createdBy`, `correlationId` |
| Media/content | Existing media reference/type/source fields, `caption`, `hashtags`, and safe TikTok settings |
| Scheduling | Firestore `scheduledAt`; mapper/API projections expose UTC ISO time; `status` is the queue state |
| Queue status | Existing `pending`, `scheduled`, `processing`, `ready`, `posted`, or `failed`; legacy `publishing` reads as `processing` and no provider state is invented |
| Approval | Stored `approvedAt` and `approvedBy`; mapped `approved` and `approvalState` are derived from a valid approval timestamp |
| Idempotency | `idempotencyKey`; `runtimeIdempotencyKey` remains a backward-compatible alias for existing P1B records |
| Publishing evidence | Existing `publishId`, `postedAt`, `lastResult`, bounded safe `history`, locks, and attempt count |
| Lifecycle | Existing `createdAt`, `updatedAt`, campaign/order metadata, and safe duplicate warning |

For an idempotent request, `schedulePost` supports exactly one owned account and
derives the document ID from `userId + accountId + idempotencyKey`. Storage uses
create-only semantics for that deterministic ID. Existing generic and Runtime
idempotency fields are checked first so older P1B jobs remain replay-safe.

No existing document is rewritten. `postsMapper.js` reads provider/platform
and idempotency aliases compatibly, defaults legacy provider identity to
TikTok, derives approval state from `approvedAt`, and leaves an unknown legacy
creation source empty instead of inventing provenance.

## Architecture

Before consolidation:

```text
Website routes -------> storage/media/schedule helpers -------> Firestore posts
Client routes --------> storage/media/schedule helpers -------> Firestore posts
P1B Runtime routes ---> separate orchestration ---------------> Firestore posts
P1A mapping adapter --> pure/read-only and inactive
Scheduler -----------> claim/approval/provider boundary ------> TikTok
```

After consolidation:

```text
Website controllers -----\
Client controllers --------> autoposterApplicationService.js
P1B Runtime controller ---/          |
                                      +--> mediaPolicy.js
                                      +--> storage.js / postsMapper.js
                                      +--> the same Firestore posts queue

P1A mapping adapter --> remains pure/read-only and inactive
Scheduler -----------> unchanged claim/approval/provider boundary --> TikTok
```

Future controlled entry points must use the same application operations. A
future provider may be added behind an explicit reviewed contract, but this
phase accepts only TikTok and adds no provider implementation.

The existing `scripts/live-publish-test.js` CLI is also a transport adapter to
`schedulePost`; its precomputed plan mode is restricted to `internal_worker`
context and still creates unapproved drafts. The CLI does not own a second
queue-construction path and never bypasses human item approval.

## Acceptance and validation

Required behavioral proof:

- Equivalent website and Runtime scheduling reaches `schedulePost` and writes
  the same canonical queue-item shape to the same `posts` collection.
- Runtime replay with the same owner, account, and idempotency key returns one
  deterministic item, including concurrent create attempts.
- Runtime scheduling remains unapproved; approval and scheduler claim checks
  remain fail-closed.
- Media, owner/account isolation, truthful delete/partial-delete, retry reset,
  queue/status normalization, and all existing browser behavior remain covered.
- No validation command performs a provider publish.

Run from the AutoPoster repository root:

```powershell
node --check src/autoposterApplicationService.js
node --test test/runtime-control-routes.test.js test/video-only-intake.test.js test/approval-gate.test.js test/queue-delete-routes.test.js test/queue-delete-storage.test.js test/scheduler.test.js
npm test
npm run build
git diff --check
git status --short --branch
```

Passing these checks proves local contract and regression coverage only. It
does not prove deployment readiness or a successful live TikTok publish.
