import { groups as groupsTable, pages as pagesTable, users as usersTable } from '../db/schema.ts'
import { getClusterNodes } from '../api/system/info.ts'
import { formatPrometheusMetrics, type MetricsSnapshot } from '../helpers/metrics.ts'
import type { FastifyInstance } from 'fastify'

/**
 * /metrics — Prometheus scrape endpoint
 *
 * SCOPE DECISION (task 594, revisited at task 1939): implemented for real, not descoped. The metric
 * set is ten gauges already computed elsewhere (`GET /_api/system/info`, `WIKI.models.jobs`,
 * `WIKI.dbManager.pool`), so the exposition writer is hand-rolled in `helpers/metrics.ts` rather
 * than pulling in `prom-client` — there are no counters, histograms or multi-metric registries here
 * to justify a client library's bookkeeping. Task 1939 added the failed-job and db-pool gauges but
 * reaffirmed this call: every new series is still a plain gauge (including `cardinaljs_jobs_failed_total`,
 * despite the `_total` suffix — see its help text), so the original rationale still holds.
 *
 * Deliberately not under `/_api`: Prometheus scrapes a fixed path with no session, and its own
 * convention is an unprefixed `/metrics`. This is the one route in the server that breaks the
 * "everything server-owned sits under a leading underscore" rule documented next to
 * `SERVER_ROUTE_SEGMENTS` in `core/http/siteRouting.ts` — the admin page's
 * `admin.metrics.endpointWarning` string says so, because it also means a wiki page created at this
 * exact path is unreachable: Fastify
 * matches a registered route before ever falling through to the page-serving catch-all.
 *
 * That same lack of an underscore also made `metrics` look like a page navigation to the global
 * site-resolution `onRequest` hook, which runs before routing hands off to this handler — a scrape
 * against a hostname mapping to no site (or a disabled one) was 302'd to `/_error/unknownsite` /
 * `/_error/disabled` before ever reaching the code below, and Prometheus follows redirects by
 * default, so it failed parsing the SPA shell instead of getting a scrape failure that says why.
 * Fixed by adding `metrics` to `core/http/siteRouting.ts`'s `RESERVED_ROOT_FILES`, the same exemption
 * `robots.txt`/`sitemap.xml` already had (OpenProject #938).
 *
 * Because this route sits outside `/_api`, it never runs through the `onRequest` hook in `index.ts`
 * that populates `req.apiKey` for `/_api/*` — that hook is scoped to the `/_api/` prefix on purpose,
 * so a scraper with no session is never mistaken for one. Bearer verification is therefore repeated
 * here, calling the same `WIKI.models.apiKeys.verify(token)` that hook calls, and the same
 * `manage:system` global permission check the shared `preHandler` hook applies elsewhere — not the
 * `read:metrics` string the admin UI used to advertise, which named no permission this repo actually
 * grants (see "Permissions" in CLAUDE.md: the global list is closed).
 */
async function routes(app: FastifyInstance) {
  app.get('/', async (req, reply) => {
    // -> Fail closed before doing anything else: while the feature is off, the endpoint does not
    //    exist as far as any caller — authenticated or not — can tell.
    if (WIKI.config.metrics.isEnabled !== true) {
      return reply.notFound()
    }

    const header = req.headers.authorization
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : ''
    if (!token) {
      return reply.unauthorized()
    }

    let apiKey
    try {
      apiKey = await WIKI.models.apiKeys.verify(token)
    } catch (err: any) {
      // -> Say why, same as the `/_api/*` bearer hook: the caller holds the credential and can act
      //    on "revoked" or "expired".
      WIKI.logger.warn('auth', 'API key refused on /metrics', { error: err })
      return reply.unauthorized(err.message)
    }

    if (!apiKey.permissions.includes('manage:system')) {
      return reply.forbidden()
    }

    // -> All seven lookups are independent round trips, so issue them concurrently rather than
    //    serially — a serial chain holds a pool connection for the sum of their latencies instead
    //    of the max, on every Prometheus scrape (task 1842).
    const [
      activeWorkers,
      pagesTotal,
      usersTotal,
      groupsTotal,
      clusterNodes,
      jobsQueued,
      jobsFailed
    ] = await Promise.all([
      WIKI.models.jobs.countActive(),
      WIKI.db.$count(pagesTable),
      WIKI.db.$count(usersTable),
      WIKI.db.$count(groupsTable),
      getClusterNodes(),
      WIKI.models.jobs.countPending(),
      WIKI.models.jobs.countFailed()
    ])

    // -> `pool` is typed `Pool | null` (it is only ever null before `dbManager.init()` completes at
    //    boot, long before this route can be serving requests) — defaulted to 0s rather than asserted
    //    non-null, so a scrape never 500s over it.
    const pool = WIKI.dbManager.pool
    const snapshot: MetricsSnapshot = {
      activeWorkers,
      pagesTotal,
      usersTotal,
      groupsTotal,
      instancesTotal: clusterNodes.length,
      jobsQueued,
      jobsFailed,
      dbPoolTotal: pool?.totalCount ?? 0,
      dbPoolIdle: pool?.idleCount ?? 0,
      dbPoolWaiting: pool?.waitingCount ?? 0
    }

    return reply
      .type('text/plain; version=0.0.4; charset=utf-8')
      .send(formatPrometheusMetrics(snapshot))
  })
}

export default routes
