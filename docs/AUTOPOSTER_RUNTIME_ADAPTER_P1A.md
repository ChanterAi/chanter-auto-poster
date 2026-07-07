# AutoPoster Runtime Adapter — P1A

## Objective

Make AutoPoster's publish/schedule/post work visible to CHANTER's control
layer without touching how it actually posts. `src/runtime/` maps existing
AutoPoster concepts (posts, campaigns, tick summaries, TikTok accounts)
into runtime-style tasks, produces decision-only publish policy previews,
and exports redacted evidence bundles — all read-only, all local to this
repo.

This is a foundation layer, not a rewrite. Nothing in `src/runtime/`
touches Firestore, TikTok, Instagram, or the scheduler. It cannot publish,
schedule, delete, or make a network call, by construction — every mapping
function is a pure function over plain data already produced elsewhere in
the app (`postsMapper.js`, `campaignAccounting.js`, `scheduler.js` tick
summaries, TikTok account records).

## Module layout

| File | Responsibility |
| --- | --- |
| `src/runtime/runtimeRedaction.js` | Deep, JSON-safe redaction of secrets and signed media URLs. |
| `src/runtime/runtimePolicy.js` | Decision-only policy evaluator for `read/write/schedule/publish/delete/network`. |
| `src/runtime/runtimeEvidence.js` | Redacted evidence bundle builders. |
| `src/runtime/runtimeReadiness.js` | Static adapter readiness report. |
| `src/runtime/autoposterRuntimeAdapter.js` | Task-mapping functions that tie the above together. |
| `src/runtime/index.js` | Single entry point — `require('./runtime')` (or `require('../runtime')`). |

Nothing outside `src/runtime/` was changed except `package.json`'s `build`
script, which now runs `node --check` over the new files, and this doc.

## Runtime task mapping

Nine AutoPoster concepts map to nine task types, each returned as a plain
object with the shape:

```js
{
  product: 'auto_poster',
  taskId, taskType, objective,
  riskLevel,              // low | medium | high | critical
  executionPolicy,        // 'standard' | 'publish_guarded'
  primaryAction,          // the policy action this task is most associated with
  status,                 // internal status, mirrors the AutoPoster status set
  inputs,                 // redacted echo of the fields the mapper read
  evidence,               // an attached, redacted evidence bundle
  validationCommands,     // ['npm run build', 'npm test']
  result,                 // always { status: 'not_executed', note: '...' }
  recommendation,
  createdAt, updatedAt
}
```

| Concept | Function | `executionPolicy` | `riskLevel` |
| --- | --- | --- | --- |
| Campaign creation | `mapCampaignCreationTask` | `publish_guarded` | medium |
| Scheduled post | `mapScheduledPostTask` | `publish_guarded` | medium |
| Queued job | `mapQueuedJobTask` | `publish_guarded` | medium |
| Post-now request | `mapPostNowRequestTask` | `publish_guarded` | high |
| Cron/tick processing | `mapCronTickTask` | `publish_guarded` | high |
| Publish attempt | `mapPublishAttemptTask` | `publish_guarded` | critical |
| Publish result | `mapPublishResultTask` | `publish_guarded` | medium (success) / high (failure) |
| Account/channel selection | `mapAccountSelectionTask` | `standard` | low |
| Media/caption payload | `mapMediaCaptionPayloadTask` | `standard` | low |

Every task type that could ever lead to an external publish call —
directly or via the scheduler — is classified `publish_guarded`. Only the
two purely local bookkeeping concepts (which account is selected, what
media/caption is attached) are `standard`.

## Publish-guarded policy preview

`runtimePolicy.evaluatePolicy({ task, action, dryRun })` returns a
decision-only object: `{ decision: 'allow' | 'deny' | 'requires_approval', allowed, requiresApproval, reason, dryRun, decisionOnly: true, evaluatedAt }`.
It never executes, publishes, deletes, or calls a network API — it only
answers "what would be allowed."

Rules, in the order they're applied:

1. Unknown action or missing task → `deny`.
2. Terminal task (`status` is `posted`/`failed`/`cancelled`, or `task.terminal === true`) → `deny` for every action, including `read`.
3. `dryRun: true` → `allow` (nothing executes either way; this just short-circuits the preview).
4. `read` → `allow`.
5. `delete` → `deny` (blocked by default, unconditionally).
6. `write` / `schedule` → `allow` only if `status` is one of `pending`/`scheduled`/`ready` (never `processing`, which the real scheduler holds as an active lock); `requires_approval` instead of `allow` when `riskLevel` is `high`/`critical`.
7. `publish` → `deny` unless `task.executionPolicy === 'publish_guarded'`; when guarded, always `requires_approval` — this adapter never itself publishes.
8. `network` → always `requires_approval`.

`evaluateAction(task, action, options)` in `autoposterRuntimeAdapter.js`
is a thin convenience wrapper around the same function.

## Redaction guarantees

`runtimeRedaction.redactRuntimeValue()` is the single choke point every
evidence bundle and task `inputs` object passes through before leaving
`src/runtime/`. It redacts:

- Exact key matches (normalized, case/format-insensitive): access/refresh
  tokens, bearer tokens, `Authorization`, API keys, client secrets, session
  secrets, admin password, OAuth/auth codes, `open_id`, `code`, Firebase
  private key, cron secret.
- Any key whose normalized form *contains* `token`, `secret`, `password`,
  `apikey`, or `bearer` — so prefixed/nested variants like
  `tiktokAccessToken` or `instagramClientSecret` are caught without an
  exhaustive enumeration.
- String *values* that look like secrets regardless of key name: JWT-shaped
  triples, or long (32+ char) unbroken alphanumeric runs with no
  whitespace — independent of what the field is called.
- Signed/temporary query parameters (`token`, `signature`, `sig`,
  `expires`, AWS/Google signed-URL params, etc.) inside any `http(s)` URL
  string, wherever it appears. The host and path stay visible; only the
  sensitive query values are replaced.
- Nested objects and arrays, recursively, with circular references
  degrading to `'[CIRCULAR]'` instead of throwing.

Ordinary campaign text — captions, account labels, usernames, validation
messages — passes through unchanged unless it happens to match one of the
secret-shaped value heuristics above.

This module is intentionally independent from `src/tiktok.js`'s existing
`redactSensitive()` (used for production log redaction). They overlap in
behavior by design, but the runtime adapter must not depend on — or be
able to influence — the production posting flow's redaction logic.

## Evidence bundle format

`runtimeEvidence.js` builds one JSON-safe, redacted bundle per event kind:
`campaignQueuedEvidence`, `scheduleCreatedEvidence`, `postNowRequestedEvidence`,
`cronTickEvidence`, `publishDecisionEvidence`, `publishResultEvidence`,
`validationResultEvidence`. Every bundle shares this shape:

```js
{
  product: 'auto_poster',
  taskId, taskType, actionType,
  accountLabel,
  scheduledAt,
  captionSummary,   // truncated to 140 chars + '…', never the raw payload
  mediaReference,   // redacted if it carries a signed/query token
  decisionResult,
  recommendation,
  createdAt, updatedAt, generatedAt
}
```

`cronTickEvidence` additionally attaches a `tickSummary` of safe numeric
counts only (`checked/due/posted/failed/ok`). `publishResultEvidence`
attaches a redacted `resultSummary` (`ok/mode/reason/publishId`).
`validationResultEvidence` attaches `validation` (`commands/passed/notes`).

## Adapter readiness

`runtimeReadiness.getAdapterReadiness()` (also exported from the top-level
`src/runtime` barrel) returns a static, read-only report:

```js
{
  product: 'auto_poster',
  adapter: 'autoposter_runtime_adapter',
  version: 'P1A',
  decisionOnly: true,
  executesNoNetworkCalls: true,
  supported: [
    'task_mapping',
    'publish_policy_preview',
    'redacted_evidence_export',
    'dry_run_decisions',
    'schedule_job_metadata_mapping'
  ],
  notSupportedYet: [
    'live_package_import_from_chanter_agent_runtime',
    'operator_live_bridge_wiring',
    'real_approval_workflow',
    'automatic_external_publish_control',
    'dashboard_runtime_panel'
  ],
  generatedAt
}
```

## Decision-only boundary

- No function in `src/runtime/` calls `fetch`, `http`, `https`, or
  requires `tiktok.js`, `instagram.js`, `firestore.js`, `scheduler.js`,
  `storage.js`, or `cloudinary.js`. This is enforced by a source-scan test
  (`test/runtime-adapter.test.js`), not just a convention.
- Every mapped task's `result` is the constant
  `{ status: 'not_executed', note: '...' }` — nothing is ever marked as
  having actually run.
- `evaluatePolicy`/`evaluateAction` only return a decision object; they
  never invoke the action they're describing.

## What's not in P1A (deferred to P1B)

- Replacing this local compatibility layer with a live package import from
  `chanter-agent-runtime`.
- Wiring into the `chanter-Operator` runtime bridge for live review/approval.
- A real approval workflow (today, `requires_approval` is just a returned
  string — nothing routes it anywhere).
- Any code path that could actually gate or trigger an external publish call.
- A dashboard runtime panel (no UI changes were made in this pass).

## How Operator will consume this later

`chanter-Operator`'s runtime bridge (P1A, committed separately) already
expects redacted evidence, decision-only policy previews, and adapter
readiness reports in this shape. Once a live package link from
`chanter-agent-runtime` exists, `src/runtime/index.js` is the intended
single seam to swap: Operator would call
`getAdapterReadiness()`/`evaluateAction()`/the `map*Task()` functions
exactly as they're shaped today, sourced from a shared package instead of
this local copy.

## No behavior change

`src/runtime/` is net-new. No existing route, scheduler, auth, or TikTok/
Instagram code was modified. `npm run build` and `npm test` cover the new
files alongside every existing check.
