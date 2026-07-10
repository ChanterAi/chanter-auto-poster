# AutoPoster Provider and Connected-Account Foundation (P2)

## Status and scope

Part 2 evolves the Part 1 application-service boundary
(`docs/AUTOPOSTER_APPLICATION_SERVICE.md`) into a provider-aware,
connected-account-ready architecture. It adds **no** new provider API
integration: TikTok remains the only active provider, and the existing
TikTok OAuth/publish implementation (`src/tiktok.js`) is reused unchanged.
Instagram, YouTube, and LinkedIn are **not** integrated. Nothing here
publishes live, migrates Firestore destructively, or redesigns the UI.

## Provider domain (`src/providers.js`)

One declarative registry defines every provider identity the product may
reference. It owns capability truth only — no storage, queue, token, or
provider-API code (enforced by test).

| Provider | Implementation status | Schedulable | Connectable | Notes |
| --- | --- | --- | --- | --- |
| `tiktok` | `active` | yes | yes (`/connect/tiktok` OAuth) | Provider #1; the only active provider |
| `instagram` | `disabled` (or `development` when `ENABLE_INSTAGRAM=true`) | **no** | **no** | Real but partial legacy integration: singleton auth doc, manual admin test route, worker path. Never schedulable through the queue. |
| `youtube` | `unsupported` | no | no | Reserved identifier only. No adapter, no OAuth, no posting support. |
| `linkedin` | `unsupported` | no | no | Reserved identifier only. No adapter, no OAuth, no posting support. |

Status vocabulary: `active`, `development`, `disabled`, `unsupported`.
Only TikTok may be `active`.

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

The source of truth remains the existing TikTok account records (the
`tiktokAccounts` collection plus the legacy singleton auth doc that
`storage.js` already normalizes lazily). `toConnectedAccount(account)`
maps one record into the single safe view:

- Identity: `connectionId` (`provider:accountId`), `provider`,
  `providerAccountId` (TikTok open id), `accountId`, `ownerUserId`,
  username/display name/avatar.
- Connection status (exact final states):
  `connected` | `reauthorization_required` | `disconnected`.
  States the product cannot determine (degraded/revoked/unknown) are
  deliberately not produced.
- Publishing readiness — **distinct from connection status** — with
  blocker codes: `provider_not_active`, `account_disconnected`,
  `reauthorization_required`, `missing_video_publish_scope`.
  A recorded scope that excludes `video.publish` blocks scheduling; an
  unrecorded scope does not (legacy records stay usable).
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
  (expired token without refresh, recorded scope missing
  `video.publish`) are rejected with `account_not_ready` and blocker
  details.
- Shared connected-account operations: `getConnectedAccount(context,
  { accountId })` and `listConnectedAccounts(context)` return safe views
  plus the provider summary. The website and the Runtime resolve channel
  identity through these same operations, so the two surfaces cannot
  drift into different account models.

## Queue compatibility

There is still exactly one queue (the Firestore `posts` collection). New
writes add, additively:

- `provider` / `platform` — validated provider id (`tiktok`),
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
- `instagram` → the existing env/health-gated legacy path, unchanged.
- Any other explicit provider → refused with terminal code
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
Scheduler worker → provider dispatch → existing TikTok boundary (tiktok.js)
```

The dashboard page shows a restrained readiness line for the active
channel (provider, implementation status, connection status, publishing
readiness, last verification) built from the safe view. Runtime queue and
status responses include `provider` and `connectedAccountId` as safe
metadata. Runtime actions (`autoposter.queue.list`,
`autoposter.post.get_status`, `autoposter.media.validate`,
`autoposter.post.schedule`) are unchanged; no Agent Runtime or MCP code
needed modification.

## Unsupported future providers

YouTube and LinkedIn exist only as registry metadata. There are no
connect buttons, no OAuth routes, no adapters, and no "coming soon" UI
for them. The site renders no control for any provider without a real
implemented flow.

## Requirements before adding the first additional provider (Part 3 readiness)

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

## Validation (executed for Part 2)

```powershell
npm test        # 186/186 passing (164 baseline + 22 new)
npm run build   # node --check chain + EJS compile + vite build — passing
git diff --check
```

No live provider call, no push, no deploy. Passing these checks proves
local contract and regression coverage only.
