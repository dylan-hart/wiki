# Decision: `/_api` does not need an explicit versioning scheme

Status: **Decided — no versioning (option a)**
Date: 2026-08-17
Related: Feature 393 ("Fix the dead X-API-Key auth scheme and finish REST API documentation
completeness"), Task 606

## Context

`/_api` is registered as a single flat, unversioned prefix (`backend/index.ts`, the
`app.register(import('./api/index.ts'), { prefix: '/_api' })` call). The Swagger document's
`info.version` is `WIKI.version` — the application's own semver (currently `3.0.0`), not a
separate API contract version. This document records the intentional decision that this stays as
it is, and why, so it isn't merely implied by nobody having changed it.

## Options considered

**(a) No versioning.** Keep `/_api` flat. `info.version` continues to be `WIKI.version`. Breaking
changes to any route ship in whatever app release makes them, with no compatibility window.

**(b) URL-prefixed versioning (`/_api/v1/...`).** Reserve a version segment now, even with only one
version in use, so a `v2` prefix could be added later and served side-by-side with `v1` during a
transition.

**(c) Header-negotiated versioning** (e.g. `Accept: application/vnd.wikijs.v1+json` or a custom
`X-API-Version` header). Callers pin a version via a header; the server dispatches to different
handler logic per version without the URL changing.

## Decision

**Option (a): no versioning.** `/_api` stays a flat, unversioned prefix, and `info.version`
continues to be `WIKI.version`. No routing or registration change is made in `backend/index.ts` or
`backend/api/index.ts`.

## Reasoning

- **The frontend and backend are one deployable unit, not two.** `frontend/` builds into `assets/`,
  which `backend/` serves; they ship in the same release, at the same commit, behind the same
  version number. There is no scenario in this app's actual deployment model where an old frontend
  talks to a new backend's `/_api`, or vice versa — the one consumer that matters is always
  upgraded in lockstep with the API it calls. Versioning exists to manage compatibility between
  independently-released producer and consumer; here there is only one release train.
- **There is no external plugin or integration ecosystem consuming `/_api` today.** A repo-wide
  search turns up no third-party API client, published SDK, webhook contract, or plugin surface
  that depends on `/_api` staying shape-stable across releases — `AdminApi.vue` / `AdminMetrics.vue`
  document the one real external credential (a bearer API key for scripts hitting the API directly),
  but nothing in-repo or documented promises those scripts a stable contract across versions today.
  Reserving a versioning scheme now would be built for a consumer that doesn't exist yet.
- **This matches the branch's explicit philosophy.** Per `CLAUDE.md`: "Nothing here has to stay
  compatible with an existing installation... do not write migration shims, legacy-value fallbacks,
  deprecated aliases." That standard already answers the API-versioning question for internal
  callers — a breaking route change is not special-cased differently from a breaking schema change;
  it ships, and the one real caller (the coupled frontend) is updated in the same commit.
  Introducing `/_api/v1` now would be scaffolding for a compatibility guarantee this project has
  deliberately decided not to make anywhere else.
- **`info.version = WIKI.version` is not a mistake to fix, it's the accurate statement of the
  actual model.** Under a coupled-deployment model, "the API contract as of this release" and "the
  app version" are the same fact stated twice. Making them different numbers would imply a
  versioning promise (independent API compatibility tracking) that doesn't hold. Swagger UI already
  contextualizes this correctly: the docs served at `/_api` are always the docs for the release
  currently running, which is the only version that can ever be true of them.
- **(c) header negotiation is rejected outright, not just deferred.** It adds real complexity —
  content-negotiation dispatch, a default-version fallback, and a second documented axis (header
  value) alongside the URL — for a single first-party consumer that will never send a version
  header because it is always upgraded with the API it calls. Even if a public integration surface
  eventually matters, (b) is the simpler mechanism (a reserved URL segment reads directly off the
  request path, requires no bespoke negotiation logic, and is what Swagger/OpenAPI tooling expects
  out of the box), so (c) is not carried forward as a fallback option either.

## When to revisit

If `/_api` ever gains a genuine external integration surface — a published plugin API, a
third-party client the project commits to supporting, or a webhook/automation contract consumed
outside this repo's own release cadence — revisit with **option (b)**: add a `/_api/v1` prefix
(`app.register(import('./api/index.ts'), { prefix: '/_api/v1' })` in `backend/index.ts`, redirecting
or aliasing the bare `/_api` if backward compatibility for existing callers is wanted at that point)
and give `info.version` a real contract version independent of `WIKI.version`. Until that consumer
exists, building the scheme is speculative and the (a) decision stands.

## Non-decision

No code changes accompany this document. Per the task's own scope, a routing/registration change
and an `info.version` update are only warranted if the decision were (b) or (c); it is (a), so
`backend/index.ts` and `backend/api/index.ts` are unchanged.
