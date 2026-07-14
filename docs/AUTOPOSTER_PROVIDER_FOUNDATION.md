# AutoPoster Provider and Connected-Account Foundation (P2)

## Status and scope

Part 2 evolved the Part 1 application-service boundary
(`docs/AUTOPOSTER_APPLICATION_SERVICE.md`) into a provider-aware,
connected-account-ready architecture. The current repository implements
TikTok and a private-only YouTube provider. TikTok is active; YouTube becomes
active only when its OAuth, encrypted token custody, enable flag, and
private-only configuration are complete, and otherwise fails closed as
disabled. Instagram remains a non-schedulable partial legacy integration and
LinkedIn remains unsupported. Nothing in the application-service operations
publishes live, migrates Firestore destructively, or redesigns the UI; provider
publishing remains behind the separate approval-gated worker boundary.

## Provider domain (`src/providers.js`)

One declarative registry defines every provider identity the product may
reference. It owns capability truth only — no storage, queue, token, or
provider-API code (enforced by test).

| Provider | Implementation status | Schedulable | Connectable | Notes |
| --- | --- | --- | --- | --- |
| `tiktok` | `active` | yes | yes (`/connect/tiktok` OAuth) | Provider #1; existing Direct Post path |
| `instagram` | `disabled` (or `development` when `ENABLE_INSTAGRAM=true`) | **no** | **no** | Real but partial legacy integration: singleton auth doc, manual admin test route, worker path. Never schedulable through the queue. |
| `youtube` | `active` when fully configured; otherwise `disabled` | yes only while active | yes (`/connect/youtube` OAuth) | Provider #2; implemented encrypted credential custody, private-only resumable video upload, and status lookup. Local code/test coverage does not establish live-production proof. |
| `linkedin` | `unsupported` | no | no | Reserved identifier only. No adapter, no OAuth, no posting support. |

Status vocabulary: `active`, `development`, `disabled`, `unsupported`.
TikTok is active. YouTube may also be active only when the complete
private-only configuration gate passes; no other provider is schedulable.

### Capability resolution

All capability questions flow through the registry:

- `assertSchedulableProvider(id)` — the fail-closed gate for every new
  scheduling write (unknown → `unknown_provider`; known but not active →
  `provider_not_schedulable`).
- `providerSupportsCapability(id, capability)` /
  `assertProviderCapability(id, capability)` — boolean capability truth;
  unknown capability names fail closed (`unknown_capability`).
- `providerSupportsMediaType(id, mediaType)` — TikTok supports `video`
  only; formats come directly from `mediaPolicy.VIDEO_EXTENSIONS`, so
  registry truth cannot drift from enforcement truth.
- `getProviderSummary(id)` / `listProviderSummaries()` — safe display
  metadata.

TikTok's declared capabilities match actual product behavior: video-only
intake (MP4/MOV/WebM), Direct Post, scheduling through the one queue,
privacy controls, human approval required, and **no** remote status
lookup, remote deletion, or analytics.

YouTube's implemented and tested capabilities are OAuth connection,
video-only private upload with subscriber notifications disabled, scheduling
through the same approval-gated queue, and remote status lookup. Public or
unlisted publishing, native `publishAt` scheduling, deletion, analytics,
thumbnails, live streaming, and playlists are not implemented and fail closed.

## Legacy provider normalization rule

`providers.normalizeStoredProviderId(raw)` implements the exact
compatibility rule used by every read and write path:

```text
MISSING legacy provider value   → normalize to TikTok (source: legacy_default)
EXPLICIT provider value         → preserved as stored (source: explicit);
                                  an unknown explicit value NEVER becomes TikTok
```

- Reads (`postsMapper.postFromDoc`): legacy documents without
  `provider`/`platform` read as `provider: "tiktok"`,
  `providerSource: "legacy_default"`. Explicit values (even unknown ones)
  are preserved with `providerSource: "explicit"` so consumers can refuse
  them.
- Writes (`storage.addUploadedPosts`): a missing provider default keeps
  TikTok; an explicit unknown provider is rejected with an error before
  any document is created. No stored record is rewritten in bulk; there is
  no migration.

## Connected-account domain (`src/connectedAccounts.js`)

The source of truth is the provider-specific account collections:
`tiktokAccounts` and `youtubeAccounts`. Existing website compatibility may
still normalize the legacy TikTok singleton lazily, but Runtime discovery,
preflight, and scheduling use canonical collection-only reads and never trigger
that migration path. `toConnectedAccount(account)` maps either record into the
single safe view:

- Identity: `connectionId` (`provider:accountId`), `provider`, exact
  `providerAccountId` / `accountId`, `ownerUserId`, and provider-native
  username/display name/avatar. TikTok uses its open id; YouTube uses its
  channel id.
- Connection status (exact final states):
  `connected` | `reauthorization_required` | `disconnected`.
  States the product cannot determine (degraded/revoked/unknown) are
  deliberately not produced.
- Publishing readiness — **distinct from connection status** — with
  blocker codes: `provider_not_active`, `account_disconnected`,
  `reauthorization_required`, `missing_video_publish_scope`.
  When scope data is recorded, TikTok requires `video.publish` and YouTube
  requires `youtube.upload`; a recorded grant that omits the required scope
  blocks scheduling. Unrecorded legacy scope data is not treated as proof that
  a grant is missing.
- Token metadata as safe booleans/timestamps only: `tokenPresent`,
  `refreshTokenPresent`, `tokenExpiresAt`, `tokenExpired`,
  `reauthorizationRequired`.
- `lastVerifiedAt` = the account's `connectedAt` (last successful OAuth
  exchange).

### Secret-handling boundary

The view is built field-by-field (allowlist). It never contains
`access_token`, `refresh_token`, client secrets, authorization codes, the
client-portal login key, or raw credential payloads. Canary-token tests
assert secrets do not appear in domain serialization, website HTML,
dashboard JSON, or Runtime responses. Existing redaction layers
(`src/tiktok.js redactSensitive`, `src/runtime/runtimeRedaction.js`)
remain unchanged and independent.

## Application-service integration

`src/autoposterApplicationService.js` is still the one product boundary
used by the website, client portal, Agent Runtime, and internal worker.
Part 2 adds:

- A registry-driven provider gate at the top of `schedulePost`: unknown
  and non-active providers fail closed **before** any account, media, or
  queue work.
- Readiness enforcement in owned-account resolution: disconnected
  channels keep the existing 409; connected-but-not-ready channels
  (expired token without refresh or the provider's required publishing scope
  missing) are rejected with `account_not_publishing_ready` and blocker details.
- Shared connected-account operations: `getConnectedAccount(context,
  { accountId })`, `listConnectedAccounts(context)`, and exact
  `validateConnectedAccount(context, { provider, accountId })` return safe
  views plus provider truth for TikTok and YouTube. Runtime discovery/preflight
  uses canonical provider collections; its TikTok reads never use the legacy
  singleton migration path.

## Queue compatibility

There is still exactly one queue (the Firestore `posts` collection). New
writes add, additively:

- `provider` / `platform` — validated provider id (`tiktok` or configured
  `youtube`),
- `connectedAccountId` — canonical composite `provider:accountId`.

Legacy documents keep working: reads derive the same
`connectedAccountId` composite for assigned legacy TikTok jobs and leave
it empty for unassigned (`legacy`) jobs. No field was removed, no
migration runs, and no second or provider-specific queue exists.

## Worker safety (`src/scheduler.js`)

The publish worker dispatches by canonical provider identity:

- `tiktok` (explicit or legacy-normalized) → the existing TikTok publish
  boundary, unchanged (including the unassigned-account block and the
  fail-closed human-approval gate).
- `youtube` (explicit, fully configured, and provider-native) → the existing
  YouTube adapter, which enforces private visibility and disabled subscriber
  notifications. This documented code path is not a claim of successful live
  or production publishing.
- `instagram` → the existing env/health-gated legacy path, unchanged.
- Any unsupported explicit provider → refused with terminal code
  `PROVIDER_UNSUPPORTED` (no retry, no TikTok fallback). Before Part 2 an
  explicit unknown provider would have fallen through to the TikTok
  publish path; this is now impossible.

## Website and Runtime account-resolution path

```text
Website render/actions ─┐
Client portal ──────────┼→ autoposterApplicationService
Agent Runtime (P1B) ────┘        ├→ providers.js          (capability truth)
MCP → Runtime → same routes      ├→ connectedAccounts.js  (safe account views)
                                 ├→ mediaPolicy.js / storage.js / postsMapper.js
                                 └→ the one Firestore posts queue
Scheduler worker → provider dispatch → TikTok / configured private-only YouTube adapter
```

The dashboard page shows a restrained readiness line for the active
channel (provider, implementation status, connection status, publishing
readiness, last verification) built from the safe view. Runtime queue and
status responses include `provider` and `connectedAccountId` as safe
metadata. Runtime actions (`autoposter.queue.list`,
`autoposter.post.get_status`, `autoposter.media.validate`,
`autoposter.post.schedule`) retain provider metadata, and the Runtime control
surface also uses the safe connected-account list and exact preflight
operations. This document makes no claim that MCP gained a new provider path.

## Unsupported future providers

LinkedIn exists only as unsupported registry metadata. Instagram remains a
non-schedulable partial legacy integration. YouTube is the implemented Provider
#2 with OAuth, canonical account storage, private-only upload, and status
lookup, but it is unavailable unless its complete configuration gate passes.
The site renders no control for a provider without an implemented flow.

## Requirements before adding another provider

1. A real OAuth flow storing per-account records into the connected-
   account source of truth (per-user scoping like TikTok's, never a
   singleton config doc).
2. A provider adapter exposing the same boundary TikTok has: readiness,
   media validation policy, publish operation, safe result mapping — and a
   worker dispatch entry for it.
3. Registry definition flipped from `unsupported`/`disabled` to `active`
   only when connection + publish + tests are real; capabilities must be
   declared from proven behavior.
4. Media policy extended per provider through the registry (not new
   `if provider === ...` branches in routes).
5. Queue documents already carry `provider`/`connectedAccountId`; the
   worker and application service already fail closed, so the new
   provider becomes schedulable only via its registry definition.
6. Parity tests (website vs Runtime), worker-safety tests, and canary
   secret tests extended to the new provider before activation.

## Historical validation (executed for the Part 2 foundation)

```powershell
npm test        # 186/186 passing (164 baseline + 22 new)
npm run build   # node --check chain + EJS compile + vite build — passing
git diff --check
```

No live provider call, no push, no deploy. These historical checks proved the
Part 2 local contract only; current validation results belong in the current
mission report and do not, by themselves, prove live-production publishing.
