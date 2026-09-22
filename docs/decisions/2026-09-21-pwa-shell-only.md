# Decision: the PWA support is an installable shell only, with no client offline use

Status: **Adopted** — OpenProject #3706 (tasks #3719, #3720, #3721).

## Decision

Cardinal.js ships the minimum a browser needs to offer installation, and nothing that makes the
client work without the server:

- A per-site web manifest at `/_site/:siteId/manifest` (`application/manifest+json`), linked from
  `frontend/index.html`, with `start_url: '/'`, `scope: '/'` and `display: standalone`.
- A service worker served by a dedicated backend route at `/sw.js` (`Cache-Control: no-cache`,
  `Service-Worker-Allowed: /`), registered from frontend boot code outside Vite dev. Its `install`
  handler only skips waiting; its `activate` handler deletes every `caches` entry and claims clients.
  It has no `fetch` handler.

Out of scope: a read-only offline cache, an offline page, offline editing (`backend/core/collab.ts`
needs a live connection), push notifications, a native app and an in-app install button. A client
without a connection gets the browser's own error page.

## Why

- Read-only caching means deciding what is safe to keep on a device: page permissions, password
  locks, classification and approvals are all evaluated per request on the server, and a cached copy
  would outlive a revoked grant.
- Offline editing would need conflict resolution against the collaborative editing server, which is a
  product of its own.
- Installability alone answers the "does it work as an app on my phone or desktop" question at the
  cost of one small, static worker.

## Consequences

- `e2e/tests/csp.spec.js` proves under `security.enforceCsp` that the worker registers with no CSP
  violation and that the manifest is fetchable and well-formed. It cannot prove that Chrome or Edge
  will actually offer the install prompt: that is the browser's own heuristic, checked by hand.
- The worker must stay free of a `fetch` handler and of cache writes. Adding either is a new decision
  and needs a new record.
- `docs/offline-deployment.md` says explicitly that the air-gapped deployment mode is a server-side
  concern and is unrelated to this feature.
