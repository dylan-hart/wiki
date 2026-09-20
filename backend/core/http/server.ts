import path from 'node:path'
import { randomUUID } from 'node:crypto'
import fastify, { LogController, type FastifyInstance } from 'fastify'
import fastifyCompress from '@fastify/compress'
import fastifySensible from '@fastify/sensible'
import fastifyStatic from '@fastify/static'
import fastifyWebsocket from '@fastify/websocket'

import {
  isHashedAssetFilename,
  isSameOriginWebSocketHandshake,
  replyWithFile
} from '../../helpers/common.ts'
import { buildRequestLogContext } from '../../helpers/requestLogContext.ts'
import { registerAjvFormats } from './ajvFormats.ts'
import { createLiveTrustProxy } from './trustProxy.ts'
import {
  createGracefulShutdown,
  registerProbes,
  SHUTDOWN,
  SHUTTING_DOWN,
  type ShutdownController
} from './shutdown.ts'

/**
 * Assigns `CARDINAL.app` and `CARDINAL.server` itself rather than returning them: the shutdown
 * handlers are registered on `CARDINAL.server` as it is built, and one `FastifyInstance` return
 * value cannot carry both.
 */
export function createHttpApp(): FastifyInstance {
  const app = fastify({
    ajv: {
      onCreate: registerAjvFormats
    },
    bodyLimit: CARDINAL.config.bodyParserLimit || 5242880, // 5mb
    // -> Fastify's own `incoming request` / `request completed` pair is off:
    //    `registerAccessLogging` emits one `http` line per request through `CARDINAL.logger` instead.
    //    Set through `logController` because Fastify 5 deprecates the top-level
    //    `disableRequestLogging` (FSTDEP023).
    logController: new LogController({ disableRequestLogging: true }),
    // -> `level: 'warn'` leaves only Fastify's own diagnostics, which `pinoStreamToWikiLogger`
    //    re-emits through `CARDINAL.logger`. `req.id` is what joins the access line to
    //    `helpers/errorHandler.ts`'s 500.
    logger: {
      level: 'warn',
      genReqId: () => randomUUID(),
      stream: pinoStreamToWikiLogger()
    },
    // -> Boolean or string (`models/security.ts#validateTrustProxySpec`), passed through verbatim:
    //    Fastify compiles a string into a `proxy-addr` trust function. Every hostname-keyed site
    //    lookup reads `req.hostname`, so a trusted-proxy address/CIDR list here, not a bare `true`,
    //    is what keeps an untrusted client's `X-Forwarded-Host` from steering a request to another
    //    site -- see `docs/audits/tls-termination.md`.
    trustProxy: createLiveTrustProxy(),
    routerOptions: {
      ignoreTrailingSlash: true
    }
  })
  CARDINAL.app = app
  registerAccessLogging(app)
  // -> `runShutdownSequence()` runs these concurrently (`Promise.allSettled`) and relies on each
  //    being internally bounded. `dbManager.shutdown()` is one entry, not its two steps:
  //    `unsubscribeFromNotifications()` needs a live pool, an order siblings would not preserve.
  CARDINAL.server = createGracefulShutdown(app, [
    () => CARDINAL.scheduler.stop(),
    () => CARDINAL.collab.shutdown(),
    () => CARDINAL.dbManager.shutdown()
  ])
  registerProbes(app, CARDINAL.server.isReady)

  app.register(fastifySensible)
  app.register(fastifyCompress, { global: true })
  /*
    Registered on the root instance because the upgrade handler is installed on the HTTP server
    itself, and before the routes because a route declaring `websocket: true` needs it already
    there.

    `maxPayload` bounds a single frame: the largest legitimate one is a client handing over a
    document it edited while offline.

    `verifyClient` is the cross-origin gate for every `websocket: true` route: a WebSocket handshake
    is neither subject to the same-origin policy nor preflighted, so CORS does not govern it, and a
    route's own session check runs against whatever cookie the browser attached. The hostnames of
    `CARDINAL.sitesMappings` are accepted too, so a handshake between two sites this instance serves
    passes.
  */
  app.register(fastifyWebsocket, {
    options: {
      maxPayload: 5242880,
      verifyClient: (info: {
        origin: string
        secure: boolean
        req: import('node:http').IncomingMessage
      }) =>
        isSameOriginWebSocketHandshake(
          info.origin,
          info.req.headers.host,
          Object.keys(CARDINAL.sitesMappings)
        )
    }
  })

  registerShutdownLogging(CARDINAL.server)

  return app
}

interface PinoRecord {
  level?: number
  msg?: string
  reqId?: string
  err?: { message?: string; type?: string }
}

/**
 * The stream Fastify's pino writes to, so its own diagnostics (`Reply was already sent`, an
 * `FST_ERR_*` raised outside a handler) land on `CARDINAL.logger` rather than on stdout as raw JSON.
 *
 * - It cannot recurse: `CARDINAL.logger` writes with `console.log` and never re-enters pino.
 * - `write` must never throw: pino writes from inside Fastify's own error path, where a throw would
 *   replace the fault being reported. A malformed record is dropped.
 */
export function pinoStreamToWikiLogger(): { write: (line: string) => void } {
  return {
    write(line: string) {
      try {
        const record = JSON.parse(line) as PinoRecord
        const message = typeof record.msg === 'string' ? record.msg : ''
        if (!message) {
          return
        }

        const fields: Record<string, unknown> = {}
        if (typeof record.reqId === 'string') {
          fields.reqId = record.reqId
        }
        if (record.err?.message) {
          // -> A serialized pino error, not an `Error` instance — rebuilt as one so the renderer's
          //    `error` handling applies to it.
          const error = new Error(record.err.message)
          error.name = record.err.type ?? 'Error'
          fields.error = error
        }

        // -> Pino's numeric levels: 60 fatal, 50 error, 40 warn. Nothing below 40 reaches here.
        const level = (record.level ?? 40) >= 50 ? 'error' : 'warn'
        CARDINAL.logger[level]('http', message, fields)
      } catch {
        // -> Deliberately silent: `write` must never throw.
      }
    }
  }
}

/**
 * One access line per request: `debug` for a success, `warn` for a 4xx, `error` for a 5xx. At the
 * default `logLevel: info` only refusals and faults show, so there is deliberately no access log
 * until an operator sets `logScopes: { http: debug }`.
 *
 * A 500 is logged twice on purpose: here as the access record, and by `helpers/errorHandler.ts`
 * with the exception and its stack. They share `reqId`.
 */
export function registerAccessLogging(app: FastifyInstance): void {
  app.addHook('onResponse', async (req, reply) => {
    const status = reply.statusCode
    const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'debug'

    CARDINAL.logger[level]('http', `${req.method} ${req.url} → ${status}`, {
      ...buildRequestLogContext(req),
      ms: reply.elapsedTime,
      ip: req.ip
    })
  })
}

/**
 * `./shutdown.ts#runShutdownSequence` reports its reason as an `Error` whose `message` is the bare
 * signal name, so these are matched exactly: an `Error('SIGTERM handler failed')` is a real fault.
 * `SIGTERM` is how Docker, Kubernetes and systemd ask for a shutdown, `SIGHUP` how some supervisors
 * do.
 */
const EXPECTED_SHUTDOWN_REASONS = new Set(['SIGINT', 'SIGTERM', 'SIGHUP'])

/**
 * `close-with-grace`'s manual `close()` carries neither a `signal` nor an `err`, so it is reported
 * with no `Error` at all. Not a fault.
 */
const PROGRAMMATIC_SHUTDOWN_REASON = 'programmatic'

/**
 * Logging only; takes the emitter as a parameter so a test can drive it with no process signalling.
 *
 * `runShutdownSequence` emits `SHUTTING_DOWN` with the reason at the top of the teardown, and
 * `SHUTDOWN` only after the pre-close delay, the close tasks and the socket close, so `stopped`'s
 * `ms` is the real cost of the drain.
 */
export function registerShutdownLogging(server: Pick<ShutdownController, 'on'>): void {
  let shutdownStartedAt: number | null = null

  server.on(SHUTTING_DOWN, (err?: Error) => {
    shutdownStartedAt = Date.now()
    CARDINAL.logger.info('boot', 'stopping', {
      reason: err?.message ?? PROGRAMMATIC_SHUTDOWN_REASON
    })
    if (err && !EXPECTED_SHUTDOWN_REASONS.has(err.message)) {
      CARDINAL.logger.warn('boot', 'shutdown reason was not an expected signal', { error: err })
    }
  })

  // -> Must log synchronously: `close-with-grace` calls `process.exit()` as soon as
  //    `runShutdownSequence` resolves. stdout writes are synchronous for pipes and TTYs on Linux
  //    and macOS, which is what keeps this line from being dropped.
  server.on(SHUTDOWN, () => {
    CARDINAL.logger.info('boot', 'stopped', {
      ms: shutdownStartedAt === null ? 0 : Date.now() - shutdownStartedAt
    })
  })
}

/**
 * The root `/favicon.ico` every browser requests unprompted, whatever `index.html`'s own
 * `<link rel="icon">` says. A committed file resolved against `CARDINAL.SERVERPATH`, like
 * `controllers/site.ts`'s `SITE_ASSET_FALLBACKS`, so it does not depend on a `vite build` output
 * that may be stale or missing.
 */
export const ROOT_FAVICON_PATH = 'assets/branding/favicon.ico'

/** Same reasoning, and the same value, as `controllers/site.ts`'s `SITE_ASSET_CACHE`. */
const ROOT_FAVICON_CACHE = 'public, no-cache'

/**
 * Must stay registered between `registerSecurity` and `registerSession`: Fastify runs plugins in
 * registration order, so moving this call is a behaviour change.
 */
export function registerStaticAssets(app: FastifyInstance): void {
  app.get('/favicon.ico', async (req, reply) =>
    replyWithFile(req, reply, path.join(CARDINAL.SERVERPATH, ROOT_FAVICON_PATH), {
      cacheControl: ROOT_FAVICON_CACHE
    })
  )
  const assetsRoot = path.join(CARDINAL.ROOTPATH, 'assets/_assets')
  app.register(fastifyStatic, {
    prefix: '/_assets/',
    root: assetsRoot,
    index: false,
    maxAge: '7d',
    decorateReply: false,
    // -> A vite build output named `[name]-[hash].[ext]` can never change under a given URL, so it
    //    is immutable. The unhashed entries fall through to the `maxAge: '7d'` default above.
    setHeaders(reply, filePath) {
      if (isHashedAssetFilename(path.relative(assetsRoot, filePath))) {
        reply.header('Cache-Control', 'public, max-age=31536000, immutable')
      }
    }
  })

  app.register(fastifyStatic, {
    prefix: '/_blocks/',
    root: path.join(CARDINAL.ROOTPATH, 'blocks/compiled'),
    index: false,
    maxAge: '1h'
  })
  // -> A custom block's code is a database row, not a file under `blocks/compiled` — served by
  //    `controllers/blocks.ts` instead. Its route has a literal `custom` segment, which the router
  //    matches ahead of this mount's wildcard.
}
