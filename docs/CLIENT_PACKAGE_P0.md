# AutoPoster Client Package — P0 Tenant Isolation

**Status:** Implemented and test-covered. Not yet deployed/pushed (see repo-root mission constraints).
**Scope:** A dedicated, isolated portal so a CHANTER client can view and manage *only their own* TikTok
posting queue — never CHANTER's internal accounts, the founder's personal accounts, other clients'
accounts, or any admin/debug surface.

## Why this exists

Before this change, the app had exactly **one** login identity for the entire system: a single shared
`ADMIN_PASSWORD` mapped to a placeholder `userId` ("owner"). There was no concept of a "client" anywhere
in the running code — anyone who had the admin password could see every connected TikTok account and
every job in the system. That is fine for CHANTER's own internal use, but unsafe to hand to a client.

The real tenant boundary that already existed in the data model was `accountId` (one Firestore document
per connected TikTok account; every scheduled post carries `accountId`). This package makes that boundary
enforceable by an actual client, without building a full multi-client user-management system.

## How a client gets access

1. An admin, from the existing internal dashboard (`/private/autoposter`), clicks **Generate Client
   Access Code** for the TikTok account (channel) they want to hand off. This calls
   `POST /private/autoposter/account/:accountId/client-access`.
2. The server generates a random code shaped `<clientLoginId>.<secret>` and stores only:
   - `clientLoginId` — a random, non-secret lookup key (plaintext, used for an O(1) equality query).
   - `clientAccessSecretHash` — an `scrypt` hash of `secret`, salted per-account (never the raw secret).
   The raw code is shown **once**, in the response body (never a URL query string, so it never lands in
   browser history or server access logs).
3. The admin shares that code with the client through a secure channel.
4. The client enters the code at `/client/autoposter/login`. The server looks up the account by
   `clientLoginId` (single indexed equality query, not a scan of all accounts), verifies the secret's
   hash, and — on success — issues a signed, `HttpOnly` session cookie (`chanter_client_session`)
   cryptographically bound to exactly one `accountId`. That binding cannot be widened from the client
   side; it is baked into the signed token.
5. An admin can **Rotate** (generate a new code, invalidating the old one) or **Revoke** access at any
   time from the same dashboard section. Revocation is re-checked on *every* client request (not just at
   login), so it takes effect immediately rather than waiting for the session to expire.

See `src/clientAuth.js` for the hashing/signing implementation and `src/storage.js`
(`generateClientAccessCode`, `verifyClientAccessCode`, `resolveClientAccount`) for the Firestore side.

## Routes

| Surface | Route | Notes |
|---|---|---|
| Admin/internal | `/private/autoposter`, `/private/autoposter/dashboard`, `/autoposter-dashboard/*` | Unchanged. Single shared admin password. Sees all TikTok accounts, all jobs, debug tooling. |
| Client | `/client/autoposter/login` | Access-code login. Rate-limited (5 attempts / 15 min / IP), separate from the admin login limiter. |
| Client | `/client/autoposter` | The portal itself: account status, create/schedule post, queue/history. |
| Client | `/client/autoposter/tiktok/reconnect` | Starts TikTok OAuth, scoped to the client's bound account. |
| Client | `/client/autoposter/posts/:id/prepare` \| `/pending` \| `/delete` | Post-now, retry, delete — all ownership-checked against the client's bound `accountId`. |
| Shared (unavoidable) | `/auth/tiktok/callback` | TikTok's OAuth `redirect_uri` is a single fixed URL, so both the admin "connect a channel" flow and the client "reconnect my channel" flow land here. The handler dispatches by which OAuth state cookie is present (`tiktok_oauth_state` for admin, `client_tiktok_oauth_state` for client) before running either flow's logic. Neither flow's behavior changed — only the dispatch is new. |

`src/clientRoutes.js` contains every `/client/*` route and never imports `src/routes.js` (the admin
router) or the React admin dashboard bundle, so the client surface cannot accidentally render admin UI.
The one necessary coupling is the reverse: `src/routes.js`'s `/auth/tiktok/callback` handler imports
`clientRoutes.handleTikTokReconnectCallback` for the shared-callback dispatch described above.

## What a client can access

- Their own connected TikTok account's status (handle, avatar, connected/disconnected, last refreshed).
- Their own create/schedule form (single account — no channel picker, no multi-channel campaign tools).
- Their own queue/history (scheduled, processing, posted, failed) with a friendly status message.
- Reconnect their own TikTok account if the connection expired or was disconnected.

## What a client cannot access (and how it's enforced)

| Risk | Enforcement |
|---|---|
| Seeing another client's or CHANTER's TikTok accounts | The client session token carries exactly one `accountId`, set at login and never accepted from client input. `storage.resolveClientAccount` re-fetches by that exact `accountId` on every request. |
| Seeing another client's posts/jobs | Every query in `clientRoutes.js` is `storage.getPosts(userId, accountId)` / `storage.getPost(userId, id, accountId)` — never the unscoped `storage.getPosts(userId)` or `storage.getDashboardJobs(userId)` (which return *every* account's jobs and are admin-only, used only by `routes.js`). |
| Acting on another account's post by guessing/reusing a post id | `storage.getPost`/`updatePost`/`deletePost` independently verify `post.accountId === accountId` server-side before returning or mutating anything — fails closed (returns `null`/`false`) on mismatch. Covered by a cross-tenant test (see below). |
| Admin dashboard, account switcher, debug panels, raw `lastResult` JSON dumps | The client views (`client-login.ejs`, `client-portal.ejs`) are separate EJS templates with no admin markup. The queue renders a derived friendly status (`clientPostStatus()`), never the raw `lastResult`/`publishId`/response JSON that the admin view exposes in its "Advanced" panel. |
| Reconnecting to a *different* TikTok account and silently taking over that account | The OAuth callback explicitly checks `auth.open_id === account.accountId` (the account bound to the client's session) before saving anything; on mismatch it rejects with a clear message and saves nothing. |
| Session outliving a revoked access code | `requireClientSession` re-reads the account from Firestore on every request and checks `clientAccessEnabled`; a revoked/deleted account is rejected immediately, not just at the next login. |
| Login enumeration / brute force | Same 5-attempts/15-minute-window limiter pattern as the existing admin login (in-memory — see Known Limitations). Codes are compared via `scrypt` + `timingSafeEqual`, not raw string equality. |

## Account isolation rule

**`accountId` is the tenant boundary**, not the shared `userId` placeholder (which is currently identical
for every account in the system — see the "why this exists" section above). Any new client-facing code
must scope every read/write by the client's session-bound `accountId`, using the storage functions that
already accept and enforce it. Never call `storage.getTikTokAccounts` (plural/unscoped), `storage.getPosts`
without an `accountId` argument, or `storage.getDashboardJobs` from client-facing code — those are the
admin "show everything I own" functions.

## Job/history isolation rule

Every post document already carries `accountId` (see `ARCHITECTURE.md`). The client queue is
`storage.getPosts(userId, accountId)`, and every queue action (`prepare`/`pending`/`delete`) re-verifies
`accountId` ownership at the storage layer before touching Firestore. No client route ever reads a job by
id without also passing the expected `accountId`.

## TikTok connection / reconnect notes

- Reconnect reuses the existing TikTok OAuth app (single `TIKTOK_CLIENT_KEY`/`TIKTOK_CLIENT_SECRET`,
  single registered `redirect_uri`). There is no separate TikTok app per client.
- If a client reconnects with a *different* TikTok account than the one bound to their session, the
  callback rejects the change and surfaces a message directing them to contact CHANTER support — it does
  not silently rebind their session to a new account.
- Token refresh, chunked video upload, and the Direct Post publish path are all unchanged from the
  existing admin flow (`src/tiktok.js`); the client portal reuses the exact same `scheduler.processPost`
  and publish pipeline, just gated behind the client's own ownership check first.

## Known limitations / remaining risks

- **Login rate limiting is in-memory** (same as the pre-existing admin login limiter — see
  `AUTO_POSTER_AUDIT.md` P1-2, still open). A server restart resets the attempt counter for both admin and
  client logins. Not a regression introduced by this package, but worth fixing alongside P1-2.
- **No client self-service password/code reset.** Only an admin can rotate a lost/leaked code. This is a
  deliberate scope limit (no client user-management CRUD), not an oversight.
- **Client login has no per-account timing-attack hardening beyond `scrypt` + `timingSafeEqual` on the
  hash comparison itself.** The Firestore lookup-by-`clientLoginId` step happens before the hash
  comparison, so a sufficiently precise timing side-channel could in theory distinguish "no such login ID"
  from "login ID exists, wrong secret." This is a pre-existing class of risk for any lookup-then-verify
  login design and is not fully closed here; documented rather than silently ignored.
- **Single shared `userId` placeholder remains true internally.** This package does not change the
  underlying single-owner architecture — it adds a second, narrower authentication surface (`accountId`-
  scoped) on top of it. If CHANTER ever needs true multi-owner (not just multi-account-under-one-owner),
  that is a larger, separate migration.
- **No automated regression test locks in that `csrfOriginCheck` covers the new `/client/*` routes**,
  beyond the fact that it is mounted globally in `server.js` before the router (same pattern already
  flagged as a gap for admin routes in `AUTPOSTER_P0_VERIFICATION_REPORT.md` §1, finding 2). The dedicated
  client-route tests intentionally omit `csrfOriginCheck` from their test app (matching
  `test/private-routes.test.js`'s existing convention) so they can assert on route logic directly; CSRF
  coverage itself lives in `test/csrf-wiring.test.js`.
- **No full automation, recurring-posting engine, AI caption/music, or multi-client admin CRM** were
  added — all explicitly out of scope for this package.

## Manual smoke test checklist

1. Log in as a client at `/client/autoposter/login` using an access code an admin generated.
2. Confirm only one TikTok account is visible (no list, no switcher).
3. Confirm no CHANTER/founder accounts appear anywhere on the page.
4. Confirm no other client's accounts or posts appear anywhere on the page (view source / inspect network
   responses, not just the rendered UI).
5. Create and schedule one post (upload a photo/video + caption).
6. Confirm the job appears only in that client's queue/history — log in as a different client (or as
   admin) and confirm it does not appear there.
7. Force a failed job (e.g. disconnect the TikTok account, then try "Post Now") and confirm the client
   sees a short, safe, human-readable error — not a raw JSON dump.
8. Confirm admin/dashboard/debug controls (`/private/autoposter`, `/autoposter-dashboard`, the "Advanced"
   raw-result panel) are completely absent from the client portal's HTML.
9. Refresh the client portal repeatedly and confirm no other account's data ever appears, even
   transiently.
10. Resize to a mobile viewport and confirm the account card, create-post form, and queue are all usable.

## Validation

See the mission's final report for exact command output. Summary: `npm test` and `npm run build` both
pass with the new files included in their respective checks (`package.json`'s `build` script now runs
`node --check` on `src/clientAuth.js`, `src/clientRoutes.js`, and compiles the three new EJS templates;
`npm test` picks up `test/client-auth.test.js` and `test/client-routes.test.js` via its existing
`test/*.test.js` glob).
