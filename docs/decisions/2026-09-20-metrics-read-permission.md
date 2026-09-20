# Decision: `/metrics` accepts `read:metrics` as well as `manage:system`

**Date:** 2026-09-20 · **Context:** OpenProject #3573 (Add a metrics-only credential so `/metrics`
does not need a `manage:system` key), under Feature #3475. Supersedes the "`manage:system` only"
choice recorded in `docs/operations.md`'s Metrics section.

## Background

`GET /metrics` verified a Bearer API key and required `manage:system`. A Prometheus scraper therefore
held a key able to do everything on the instance, to read four counters and some pool gauges.

## Decision

Add `read:metrics` to the closed global-permission list. `/metrics` accepts a key whose resolved
permissions include `manage:system` OR `read:metrics`. An operator creates a service user in a group
holding only `read:metrics` and mints a key for it, optionally with `scope: ['read:metrics']`.

- The Bearer requirement stays. No anonymous, localhost or LAN class of scrape was added: it would
  depend on `trustProxy` being right, and a wrong setting would open the endpoint to the internet.
- Flag off is still a 404 for every caller; a missing or invalid key is still 401; a valid key with
  neither permission is still 403.
- `read:metrics` is checked only by `controllers/metrics.ts`. It grants no route, page or admin access.

## Rejected alternative

A special key flag that bypasses scope narrowing. A key's `scope` is an intersection with the
owner's permissions (`narrowToScope` in `models/apiKeys.ts`), never a grant, so a scope value alone
cannot let a low-privilege owner scrape. A flag that overrode that would break the invariant every
other key relies on. A permission fits the existing model unchanged.
