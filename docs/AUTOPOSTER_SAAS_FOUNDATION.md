# AutoPoster SaaS Foundation

## Status and scope

This document describes the workspace, plan, entitlement, and usage foundation used by the existing AutoPoster product. It does not describe a payment integration. AutoPoster has no checkout, billing webhook, public price, invoice, refund, tax, or customer subscription-purchase flow.

The protected AutoPoster website remains the product. `autoposterApplicationService.js` remains the shared business boundary used by the Website and Runtime control routes. Agent Runtime and MCP are controlled adapters into those routes; they do not own plan or quota truth.

Implemented publishing providers remain TikTok and private-only YouTube. A numerical plan provider limit does not enable Instagram, LinkedIn, or another provider.

## Canonical workspace and membership

Workspace records are stored in `workspaces` and contain:

- `workspaceId`, `displayName`, `slug`, and `ownerUserId`
- `status`: `active`, `suspended`, or `archived`
- bounded scalar metadata
- timestamps and `schemaVersion`

Membership records are stored in `workspaceMemberships`. The implemented operational role is `owner`; role constants for future use do not implement team invitations or team administration.

`workspaceService.resolveActiveWorkspace` is the canonical resolution path. An explicit workspace ID must resolve through an active owner membership. Unknown, unauthorized, inactive, or structurally invalid workspaces fail closed and do not silently fall back to another workspace.

New records retain the existing `userId` ownership field and add `workspaceId`. Existing owner checks remain defense in depth.

## Legacy compatibility

The server may lazily create one deterministic default workspace for a server-verified legacy owner. That operation creates the workspace, owner membership, and internal compatibility subscription transactionally.

Legacy account or queue records without `workspaceId` are readable only when all of the following are true:

- the record still belongs to the authenticated legacy owner;
- the active workspace is that owner's deterministic default workspace; and
- the workspace carries the internally created `legacy_default` compatibility marker.

An explicit workspace cannot set that reserved marker. A different or unknown workspace never inherits unscoped records. New account and queue writes persist an explicit workspace ID.

No ordinary read performs a broad data migration. No live migration is part of this foundation.

## Plan catalog

`planCatalog.js` is the only plan configuration source. Public plan IDs are `starter`, `creator`, and `studio`. `legacy_full_access` is internal-only, has no public price, and preserves the verified pre-subscription workspace without imposing migration-time quotas.

The catalog owns workspace, provider, connected-account, scheduled-post, active-queue, batch-size, scheduling-horizon, Runtime scheduling, and advanced-evidence entitlements. Billing fields (`monthlyPrice`, `currency`, `billingInterval`, and `externalPriceId`) remain null. Public plan serialization excludes the internal compatibility plan.

Plan allowance never makes an unimplemented provider operational.

## Subscription truth

One subscription document per workspace is stored in `subscriptions`. Its deterministic record supports:

- canonical workspace and plan IDs;
- `trialing`, `active`, `past_due`, `canceled`, `internal`, or `none` status semantics;
- internal or future billing-provider source;
- explicit period start and end;
- cancel-at-period-end state;
- bounded entitlement overrides;
- nullable billing provider, external customer, and external subscription IDs;
- timestamps and schema version.

`subscriptionService.resolveSubscription` is the canonical resolver. Internal legacy access must use `source=internal` and `status=internal`. Public plans may be assigned only by server-side internal/test fixtures in this milestone. Billing-managed records cannot be changed through the internal update method.

Entitlement overrides are limited to known fields and bounded values. They cannot enable an unsupported provider. External billing IDs and raw overrides are omitted from the public subscription and Plan & Usage projections.

`subscriptionPlanChangeIntents` records an idempotent, non-billing plan-change request. It is not checkout and does not activate a plan.

## Entitlement evaluation

`entitlementResolver.js` resolves:

`workspace -> subscription -> catalog plan -> bounded overrides -> effective entitlements`

Its decisions contain `allowed`, a safe `reasonCode` and reason, `current`, `limit`, `remaining`, `planId`, `workspaceId`, and an evaluation timestamp. Denials distinguish inactive workspace/subscription, unavailable feature, provider/account limits, cycle quota, active queue, batch size, scheduling horizon, and Runtime scheduling.

The resolver does not accept browser, Runtime, or MCP plan claims. If workspace, subscription, plan, entitlement, or usage truth cannot be verified, a commercial mutation is denied before a connected account or queue item is created.

## Usage ledger and counters

`usageService.js` owns the `scheduled_posts` metric:

- `usageLedger` stores one deterministic reservation per idempotency key and queue resource.
- `usageCounters` stores cycle-scoped reserved, consumed, released, and accepted quantities.
- `usageActiveQueueCounters` stores workspace-wide active queue occupancy so an active job from a previous cycle still counts.
- the canonical queue remains the existing `posts` collection.

Queue acceptance creates the ledger reservation, updates both counters, and creates the queue document in one Firestore transaction. Distinct concurrent requests serialize through shared counter documents. A duplicate idempotency key returns the existing queue item without a second reservation. A reservation failure creates no queue item, and a queue-create failure commits no usage changes.

Cycle identity is explicit. Internal and legacy subscriptions use calendar-month UTC cycles. A future externally managed subscription period uses a deterministic identity derived from its exact start and end, so a period crossing a calendar boundary does not reset quota.

### Lifecycle

- Accepted queue item: `reserved`; scheduled-post usage and active queue each increase once.
- Successful TikTok post or private YouTube upload: reservation becomes `consumed`; active queue decreases once; no new charge is added.
- Operator deletion before provider side effect: reservation becomes `released` and the queue item is deleted in the same transaction.
- Retryable or terminal known failure: reservation and active queue remain held because the current operator workflow may retry; deletion releases it.
- Outcome unknown: reservation remains held, active queue leaves the claimable queue once, and automatic release/retry/delete is blocked pending reconciliation.
- Already consumed or already released transitions are idempotent.

Processing, outcome-unknown, and reconciliation-required queue items cannot be deleted. Only a definitively failed item can be reset for retry. Generic edits cannot turn processing, posted, or outcome-unknown evidence back into a schedulable job.

## Connected-account activation

OAuth starts and callbacks bind to a verified workspace. YouTube state and channel selection, and the admin TikTok state, are server-side, short-lived, single-use records. Commercial account/provider limits are resolved server-side immediately before activation. Credentials obtained from OAuth remain in memory and are discarded if activation is denied.

Account persistence must preserve both ownership and workspace isolation. A reconnect updates the same provider account rather than creating a second logical connection. Disconnect preserves queue/history and releases connection capacity. Provider credentials remain behind provider-specific storage methods and never enter plan, usage, Runtime, MCP, or UI responses.

## Shared enforcement path

The Website and Runtime routes construct an execution context containing authenticated owner identity and an optional workspace request. The application service resolves the verified commercial context, connected account, provider, entitlement decision, and usage reservation before queue creation.

Runtime scheduling uses the same operation and usage path as Website scheduling. `workspaceId` is additive and optional across AutoPoster, Agent Runtime, and MCP. Agent Runtime scopes its idempotency cache by product, tenant, workspace, and caller key. MCP rejects unknown plan, quota, and entitlement fields rather than forwarding them.

Runtime and MCP list/status operations do not consume usage. Safe structured commercial denials stay denials across both adapters. Credentials, entitlement overrides, and external billing identifiers are not returned.

## Workspace isolation

Workspace scope is applied to connected accounts, queue reads/writes, Command Center aggregation, Publishing Log, usage, subscriptions, Runtime list/status/schedule, and MCP missions. Existing `userId` and account ownership checks remain in place.

An unauthorized or unknown explicit workspace returns the same safe not-found boundary. It cannot list another workspace's posts or accounts, schedule against its quota, inspect plan/usage, or delete its records.

## Plan & Usage UI

The existing protected site includes a restrained Plan & Usage section showing the active workspace, effective plan/status, usage period, scheduled-post usage, connected accounts, active providers, active queue, scheduling horizon, and Runtime availability.

Starter, Creator, and Studio comparison content is derived from the catalog, including workspace, account/provider, post, queue, batch, horizon, Runtime, and evidence differences. `legacy_full_access` is shown only as an internal compatibility label. No monetary price or purchase action is rendered. The current billing message is: `Billing activation not yet available`.

Command Center receives only the safe commercial projection and keeps provider/status truth operational rather than becoming a billing dashboard.

## Billing-ready boundary

The current boundary is data-ready, not billing-enabled.

### Existing records and services a future integration would use

- Resolve and authorize the owner workspace with `workspaceService`.
- Resolve canonical plan IDs and configured billing fields from `planCatalog`.
- Store external provider/customer/subscription identity and period/status truth in the existing workspace subscription document.
- Add a billing-event application method beside `subscriptionService.resolveSubscription`; do not misuse `updateInternalSubscription` to fabricate provider state.
- Record a pre-checkout request with `subscriptionService.recordPlanChangeIntent` when the product explicitly enables that flow.
- Let `entitlementResolver` consume the updated subscription record; billing handlers must not write entitlements into browser state.

### Future environment variables

No billing variables are configured today. A separate Stripe milestone would require names equivalent to:

- `BILLING_PROVIDER=stripe`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- server-side Starter, Creator, and Studio price identifiers, for example `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_CREATOR`, and `STRIPE_PRICE_STUDIO`
- the canonical public application origin used for allowlisted success/cancel URLs

Names and values must be finalized against the deployment's existing environment convention. They must never be exposed to the client bundle or committed.

### Plan-to-price mapping

The mapping must remain server-side and keyed by the canonical catalog IDs. The catalog already exposes nullable `externalPriceId`; a real integration may populate it from validated server configuration or introduce one billing-adapter mapping next to the catalog. Templates, Runtime inputs, and MCP inputs must not supply price IDs.

### Required webhook behavior

A Stripe implementation would normally handle at least:

- `checkout.session.completed` to associate an authenticated workspace intent with a provider customer/subscription, without granting access from redirect parameters;
- `customer.subscription.created` and `customer.subscription.updated` for plan, status, period, and cancel-at-period-end truth;
- `customer.subscription.deleted` for terminal subscription truth;
- `invoice.paid` (or the selected current Stripe success event) and `invoice.payment_failed` for enforceable payment status transitions.

Every webhook must verify its signature, store/process the provider event ID idempotently, validate workspace/customer/subscription mapping, reject unknown price IDs, apply events in an order-safe way, and return success only after durable state is reconciled. Replayed events must not apply a second plan transition.

### Checkout routes

A future authenticated checkout-start route must resolve owner workspace, requested canonical public plan, and server-side price mapping; create a provider session with an idempotency key; and bind workspace/intent through trusted metadata. Success and cancel routes must be allowlisted internal paths. The success page may display pending/current subscription truth read from the server, but only a verified webhook may activate entitlements. Cancel must not change the current plan.

### Intentionally unimplemented

There is no billing SDK/client, checkout/session route, payment webhook route, public upgrade button, customer portal, invoice/refund/tax flow, real price mapping, or paid-subscription claim.

## Migration and readiness gates

No live workspace, subscription, account, post, or usage migration runs automatically. Before production billing activation:

1. Run a read-only legacy ownership/account/post ambiguity report.
2. Approve and test any migration against an emulator or isolated project.
3. Configure and validate provider event signatures and server-only price mapping.
4. Add provider-event idempotency and out-of-order delivery tests.
5. Test account activation, queue reservation, worker consume, cancellation release, and outcome-unknown reconciliation under concurrency.
6. Verify Website, Runtime, and MCP denial parity and secret-redaction canaries.
7. Perform a separately authorized deployment and supervised billing-provider test.

Known limitations are deliberate: owner-only membership, no invitations/team UI, no customer checkout, no public pricing, no automatic legacy migration, and no automatic reconciliation flow for ambiguous provider outcomes.
