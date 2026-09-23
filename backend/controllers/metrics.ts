import { groups as groupsTable, pages as pagesTable, users as usersTable } from '../db/schema.ts'
import { getClusterNodes } from '../api/system/info.ts'
import {
  createRuntimeSampler,
  formatPrometheusMetrics,
  formatPubsubMetrics,
  formatRuntimeMetrics,
  type MetricsSnapshot
} from '../helpers/metrics.ts'
import { notifierStats } from '../helpers/pubsub.ts'
import type { FastifyInstance } from 'fastify'

const METRICS_PERMISSIONS = ['manage:system', 'read:metrics']

/**
 * Prometheus scrape endpoint. Every series is a plain gauge already computed elsewhere, so the
 * exposition writer is hand-rolled in `helpers/metrics.ts` rather than pulling in `prom-client` —
 * there are no counters, histograms or registries to justify a client library.
 *
 * Deliberately not under `/_api`: Prometheus scrapes a fixed path with no session, and its own
 * convention is an unprefixed `/metrics`. This is the one server-owned route without a leading
 * underscore, so a wiki page created at this exact path is unreachable, and `metrics` must stay in
 * `core/http/siteRouting.ts`'s `RESERVED_ROOT_FILES` or the site-resolution hook redirects a scrape
 * like a page navigation.
 *
 * Outside `/_api` also means the bearer `onRequest` hook (`core/http/authHooks.ts`) never populates
 * `req.apiKey` here, so bearer verification and the permission check (`manage:system` or `read:metrics`) are repeated
 * below.
 */
async function routes(app: FastifyInstance) {
  let runtimeSampler: ReturnType<typeof createRuntimeSampler> | null =
    CARDINAL.config?.metrics?.isEnabled === true ? createRuntimeSampler() : null
  app.addHook('onClose', async () => {
    runtimeSampler?.stop()
  })

  app.get('/', async (req, reply) => {
    // -> Checked first: while the feature is off, the endpoint does not exist as far as any caller —
    //    authenticated or not — can tell.
    if (CARDINAL.config.metrics.isEnabled !== true) {
      return reply.notFound()
    }

    const header = req.headers.authorization
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : ''
    if (!token) {
      return reply.unauthorized()
    }

    let apiKey
    try {
      apiKey = await CARDINAL.models.apiKeys.verify(token)
    } catch (err: any) {
      // -> Say why: the caller holds the credential and can act on "revoked" or "expired".
      CARDINAL.logger.warn('auth', 'API key refused on /metrics', { error: err })
      return reply.unauthorized(err.message)
    }

    if (!apiKey.permissions.some((permission) => METRICS_PERMISSIONS.includes(permission))) {
      return reply.forbidden()
    }

    const [
      activeWorkers,
      pagesTotal,
      usersTotal,
      groupsTotal,
      clusterNodes,
      jobsQueued,
      jobsFailed
    ] = await Promise.all([
      CARDINAL.models.jobs.countActive(),
      CARDINAL.db.$count(pagesTable),
      CARDINAL.db.$count(usersTable),
      CARDINAL.db.$count(groupsTable),
      getClusterNodes(),
      CARDINAL.models.jobs.countPending(),
      CARDINAL.models.jobs.countFailed()
    ])

    // -> `pool` is only null before `dbManager.init()` completes at boot — defaulted to 0s rather
    //    than asserted non-null, so a scrape never 500s over it.
    const pool = CARDINAL.dbManager.pool
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

    // -> Created here only when the plugin registered before `metrics.isEnabled` was true
    runtimeSampler ??= createRuntimeSampler()
    const runtime = runtimeSampler.collect()

    return reply
      .type('text/plain; version=0.0.4; charset=utf-8')
      .send(
        formatPrometheusMetrics(snapshot) +
          formatRuntimeMetrics(runtime) +
          formatPubsubMetrics(notifierStats())
      )
  })
}

export default routes
