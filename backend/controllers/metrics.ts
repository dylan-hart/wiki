import { groups as groupsTable, pages as pagesTable, users as usersTable } from '../db/schema.ts'
import { getInstances } from '../api/system.ts'
import { formatPrometheusMetrics, type MetricsSnapshot } from '../helpers/metrics.ts'
import type { FastifyInstance } from 'fastify'

/**
 * /metrics — Prometheus scrape endpoint
 *
 * SCOPE DECISION (task 594): implemented for real, not descoped. The metric set is six gauges
 * already computed elsewhere (`GET /_api/system/info`, `WIKI.models.jobs`), so the exposition
 * writer is hand-rolled in `helpers/metrics.ts` rather than pulling in `prom-client` — there are no
 * counters, histograms or multi-metric registries here to justify a client library's bookkeeping.
 *
 * Deliberately not under `/_api`: Prometheus scrapes a fixed path with no session, and its own
 * convention is an unprefixed `/metrics`. This is the one route in the server that breaks the
 * "everything server-owned sits under a leading underscore" rule documented next to
 * `SERVER_ROUTE_SEGMENTS` in `index.ts` — the admin page's `admin.metrics.endpointWarning` string
 * says so, because it also means a wiki page created at this exact path is unreachable: Fastify
 * matches a registered route before ever falling through to the page-serving catch-all.
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
      WIKI.logger.debug(`Rejected an API key on /metrics: ${err.message}`)
      return reply.unauthorized(err.message)
    }

    if (!apiKey.permissions.includes('manage:system')) {
      return reply.forbidden()
    }

    const snapshot: MetricsSnapshot = {
      activeWorkers: await WIKI.models.jobs.countActive(),
      pagesTotal: await WIKI.db.$count(pagesTable),
      usersTotal: await WIKI.db.$count(usersTable),
      groupsTotal: await WIKI.db.$count(groupsTable),
      instancesTotal: (await getInstances()).length,
      jobsQueued: await WIKI.models.jobs.countPending()
    }

    return reply
      .type('text/plain; version=0.0.4; charset=utf-8')
      .send(formatPrometheusMetrics(snapshot))
  })
}

export default routes
