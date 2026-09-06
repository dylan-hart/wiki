import path from 'node:path'
import { randomUUID } from 'node:crypto'
import fastify, { LogController, type FastifyInstance } from 'fastify'
import fastifyCompress from '@fastify/compress'
import fastifySensible from '@fastify/sensible'
import fastifyStatic from '@fastify/static'
import fastifyWebsocket from '@fastify/websocket'
import gracefulServer, { type IGracefulServer } from '@gquittet/graceful-server'
import ajvFormats from 'ajv-formats'

import {
  isHashedAssetFilename,
  isSameOriginWebSocketHandshake,
  replyWithFile
} from '../../helpers/common.ts'
import { buildRequestLogContext } from '../../helpers/requestLogContext.ts'

/**
 * The Fastify instance itself, everything wrapped around it that is not routing, and the static
 * mounts that answer straight off disk — the part of `initHTTPServer()` that builds a server rather
 * than wiring behaviour onto one.
 *
 * `createHttpApp()` assigns `WIKI.app` and `WIKI.server` as it goes, in the same order `index.ts`
 * did: the graceful-shutdown handlers below are registered on `WIKI.server`, so the object and its
 * handlers cannot be separated from the construction that produces them, and a single
 * `FastifyInstance` return value has nowhere to carry the second one back. `index.ts` keeps the boot
 * sequence and the `listen()` that ends it.
 */
export function createHttpApp(): FastifyInstance {
  const app = fastify({
    ajv: {
      // -> `ajv-formats` is CJS: the default import resolves to `module.exports`, so the callable
      //    plugin is reached via `.default` (verified identical at runtime: `f === f.default`).
      //    The tuple assertion is load-bearing twice over: it stops the element from widening
      //    (which makes fastify's overload resolution fall through to the HTTP/2 signature), and
      //    it bridges an upstream variance mismatch — @fastify/ajv-compiler declares plugin
      //    options as `unknown`, while ajv-formats declares its own narrower options type, and the
      //    two are contravariantly incompatible. (`ajv` itself is only a nested dependency here, so
      //    its `Plugin` type is not importable to state this more precisely.)
      plugins: [[ajvFormats.default, {}] as any],
      onCreate: (ajv: any) => {
        // -> Accepts the shorthand, alpha and full forms a color picker can produce:
        //    #RGB, #RGBA, #RRGGBB and #RRGGBBAA
        ajv.addFormat('hexcolor', (data: unknown) => {
          return (
            typeof data === 'string' &&
            /^#(?:[a-fA-F0-9]{3,4}|[a-fA-F0-9]{6}|[a-fA-F0-9]{8})$/.test(data)
          )
        })
      }
    },
    bodyLimit: WIKI.config.bodyParserLimit || 5242880, // 5mb
    // -> Fastify's own `incoming request` / `request completed` pair is off: `registerAccessLogging`
    //    below emits ONE `http` line per request through `WIKI.logger` instead, so the access log has
    //    the same scope, shape and destination as everything else the instance says. Pino used to
    //    write that pair straight to stdout as raw JSON in text mode — two lines a request, reaching
    //    neither the terminal backlog nor an aggregator's one format (4,761 pino lines against 14,266
    //    app lines in the reference container). `genReqId` stays: `req.id` is what correlates the
    //    access line with `helpers/errorHandler.ts`'s 500 (OpenProject #1937/#2662).
    //
    // -> Set through `logController` rather than the top-level `disableRequestLogging`, which
    //    Fastify 5 deprecates (FSTDEP023) and removes in 6.
    logController: new LogController({ disableRequestLogging: true }),
    // -> What is left of pino is Fastify's own diagnostics — `Reply was already sent`, an `FST_ERR_*`
    //    raised outside a handler — which have no other way out. `level: 'warn'` keeps exactly those,
    //    and `pinoStreamToWikiLogger` re-emits each one through `WIKI.logger`, so there is one stream
    //    and one format. The `logFormat: 'json'` reshaping this option block used to carry is gone
    //    with the volume it existed for: nothing reaches stdout as pino any more, so there is no
    //    second producer's envelope left to match.
    logger: {
      level: 'warn',
      genReqId: () => randomUUID(),
      stream: pinoStreamToWikiLogger()
    },
    // -> `securityTrustProxy` was the 2.x name: the setting is `trustProxy`, so this read never
    //    matched and the option was permanently off no matter what the admin area showed.
    //    `trustProxy` is boolean-or-string -- see `models/security.ts#validateTrustProxySpec` and
    //    `api/schemas/security.ts` -- and Fastify's own `getTrustProxyFn` (`fastify/lib/request.js`)
    //    is what turns a string into a compiled `proxy-addr` trust function, so it is passed through
    //    verbatim rather than coerced. A trusted-proxy address/CIDR list (not the bare `true` this
    //    admin toggle used to send) is what keeps `req.ip`/`req.hostname` from trusting
    //    `X-Forwarded-For`/`X-Forwarded-Host` sent by an untrusted client -- see
    //    `docs/tls-termination.md`. Every hostname-keyed site lookup (`core/http/siteRouting.ts`'s
    //    SEO hook, site-resolution hook and app-shell fallback, `models/sites.ts#getSiteByHostname`,
    //    and the hostname reads in `controllers/files.ts`/`seo.ts`/`site.ts` and
    //    `api/auth/provider.ts`) reads `req.hostname`, so narrowing this one setting closes the
    //    cross-site `X-Forwarded-Host` steering gap for all of them (task 2085).
    trustProxy: WIKI.config.security.trustProxy ?? false,
    routerOptions: {
      ignoreTrailingSlash: true
    }
  })
  WIKI.app = app
  registerAccessLogging(app)
  WIKI.server = gracefulServer(app.server, {
    livenessEndpoint: '/_live',
    readinessEndpoint: '/_ready',
    kubernetes: Boolean(process.env.KUBERNETES_SERVICE_HOST),
    // -> Awaited via `Promise.allSettled` by the library once the pre-close delay below has
    //    elapsed — each one is itself internally bounded (`scheduler.stop()`'s own drain timeout,
    //    `collab.shutdown()`/`dbManager.shutdown()`'s bounded socket/pool teardown), so a hung
    //    routine here cannot hold the process open indefinitely. Previously empty, so every deploy,
    //    restart or pod eviction abandoned an in-flight job, a live collab socket and the pg pool's
    //    LISTEN client rather than draining them (OpenProject #2018/#2028). `dbManager.shutdown()`
    //    is one call rather than its two steps listed separately here, because those two steps have
    //    an order dependency (`unsubscribeFromNotifications()`'s own drain needs a live pool) that
    //    `Promise.allSettled` running sibling entries concurrently would not preserve.
    closePromises: [
      () => WIKI.scheduler.stop(),
      () => WIKI.collab.shutdown(),
      () => WIKI.dbManager.shutdown()
    ],
    // -> Library default is 1000ms, spent entirely as a pre-close delay *before* `closePromises`
    //    run (not a timeout wrapping them) — barely enough for a readiness probe to notice
    //    `isReady()` has flipped and stop routing new traffic here. Raised well above that, while
    //    staying comfortably under a typical 30s Kubernetes `terminationGracePeriodSeconds` once
    //    added to `scheduler.stop()`'s own drain bound above.
    timeout: 5000
  })

  app.register(fastifySensible)
  app.register(fastifyCompress, { global: true })
  /*
    Websocket upgrades, for live collaborative editing (`controllers/collab.ts`) and the admin
    terminal's log stream (`controllers/terminal.ts`). Registered on the root instance because the
    upgrade handler is installed on the HTTP server itself, and before the routes below because a
    route declaring `websocket: true` needs it already there.

    `maxPayload` bounds a single frame: these carry keystrokes and cursor positions, and the largest
    legitimate one is a client handing over a document it edited while offline.

    `verifyClient` (task 2120 / WP 2105 §5) is the cross-origin gate for every current and future
    `websocket: true` route: a WebSocket handshake is not subject to the same-origin policy and is
    not preflighted, so CORS governs neither it nor the frames that follow — unlike a form POST, the
    response is fully readable by whichever origin opened the socket, and each route's own
    session/permission check runs against whatever cookie the browser attached regardless of which
    page attached it. One `verifyClient` here closes that for both current routes
    (`controllers/terminal.ts`, `controllers/collab.ts`) and any future one, rather than each handler
    re-deriving its own origin check. See `helpers/common.ts#isSameOriginWebSocketHandshake` --
    passed `WIKI.sitesMappings`' own hostnames too, so a handshake between two sites this same
    instance actually serves is also accepted, not only a request whose Origin matches the exact Host
    it landed on.
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
          Object.keys(WIKI.sitesMappings)
        )
    }
  })

  // ----------------------------------------
  // Handle graceful server shutdown
  // ----------------------------------------

  registerShutdownLogging(WIKI.server)

  return app
}

/**
 * The pino record shape this module reads. Everything else pino writes is passed over.
 */
interface PinoRecord {
  level?: number
  msg?: string
  reqId?: string
  err?: { message?: string; type?: string }
}

/**
 * The sidecar stream Fastify's own pino writes to, so its diagnostics land on `WIKI.logger` rather
 * than as raw JSON on stdout.
 *
 * With `disableRequestLogging` on and pino at `level: 'warn'`, what still comes through here is only
 * Fastify's own: `Reply was already sent`, an `FST_ERR_*` raised outside a handler, a serializer
 * fault. Those have no other way out of the framework, so they are translated rather than dropped —
 * the `http` scope, the record's own `msg`, and `reqId`/`error` when the record carries them.
 *
 * Two properties this has to keep:
 *
 * - **It cannot recurse.** `WIKI.logger` writes with `console.log`; it never re-enters pino, so a
 *   line emitted here cannot produce another record to translate.
 * - **`write` is total.** A malformed or non-JSON record is dropped, never thrown: pino writes from
 *   inside Fastify's own error path, where a throw would replace the fault being reported with this
 *   one.
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
          //    `error` handling (name, message, stack where the level warrants it) applies to it the
          //    same way it does to every other line.
          const error = new Error(record.err.message)
          error.name = record.err.type ?? 'Error'
          fields.error = error
        }

        // -> Pino's numeric levels: 60 fatal, 50 error, 40 warn. Nothing below 40 reaches this
        //    stream, and severity is carried across rather than flattened to one level — an
        //    `FST_ERR_*` reported as a warning would read as less than it is.
        const level = (record.level ?? 40) >= 50 ? 'error' : 'warn'
        WIKI.logger[level]('http', message, fields)
      } catch {
        // -> Deliberately silent: see the "write is total" note above.
      }
    }
  }
}

/**
 * The one access line per request, replacing pino's `incoming request` / `request completed` pair.
 *
 * `debug` for anything the server considered a success, `warn` for a 4xx, `error` for a 5xx — so the
 * refusals and faults stay visible at the default `logLevel: info` while the ordinary traffic does
 * not. **At that default there is therefore no access log at all**, which is the intended shape:
 * `logScopes: { http: info }` is how an operator turns one on for as long as they want it, without a
 * setting of its own and without restarting into a different global level.
 *
 * A 500 is consequently logged twice, on purpose: once here as the access record, and once by
 * `helpers/errorHandler.ts` with the exception and its stack. They are two different facts about one
 * request and they share `reqId`, which is what lets an operator put them back together.
 */
export function registerAccessLogging(app: FastifyInstance): void {
  app.addHook('onResponse', async (req, reply) => {
    const status = reply.statusCode
    const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'debug'

    WIKI.logger[level]('http', `${req.method} ${req.url} → ${status}`, {
      ...buildRequestLogContext(req),
      ms: reply.elapsedTime,
      ip: req.ip
    })
  })
}

/**
 * The signal names an orderly shutdown legitimately ends with.
 *
 * `@gquittet/graceful-server` reports its shutdown reason as an `Error` whose `message` is the bare
 * signal name, so these are matched exactly rather than by prefix — an `Error('SIGTERM handler
 * failed')` is a real fault and still warns.
 */
const EXPECTED_SHUTDOWN_REASONS = new Set(['SIGINT', 'SIGTERM', 'SIGHUP'])

/**
 * The reason reported for a shutdown nobody asked for by signal — a bare `WIKI.server.stop()`,
 * which graceful-server passes no `type` and no `body` for and therefore reports with no `Error` at
 * all. Not a fault, so it does not take the `warn` branch below.
 */
const PROGRAMMATIC_SHUTDOWN_REASON = 'programmatic'

/**
 * The graceful-shutdown listener, which is logging only.
 *
 * Split out of `createHttpApp()` so the branches below are reachable from a test with a fake emitter
 * rather than only by signalling a real process. Called from where the block sat inline, since the
 * handlers are registered on `WIKI.server` as it is constructed.
 *
 * Two lines, one per end of the teardown, replacing the four the HTTP server and scheduler used to
 * emit between them (`Shutting down HTTP Server`, `Stopping Scheduler`, `Scheduler: [ STOPPED ]`,
 * `HTTP Server has exited`). The library's own event pair is what makes them meaningful: it emits
 * `SHUTTING_DOWN` — carrying the reason — at the top of `stop()`, then runs the pre-close delay,
 * `closePromises` (scheduler drain, collab socket close, db unsubscribe + pool end) and the socket
 * close, and only then emits `SHUTDOWN`, immediately before `process.exit`. So `stopping` belongs on
 * the first and `stopped  ms=` on the second, and `ms` is the real cost of the drain rather than a
 * number measured against nothing.
 *
 * `SIGTERM` is how Docker, Kubernetes and systemd ask for a shutdown, and `SIGHUP` is how some
 * supervisors do — only `SIGINT` (a developer's Ctrl-C) used to be exempted, so every ordinary
 * restart logged `warn: Error: SIGTERM` with a stack and made the most common benign event in an
 * instance's life read as a fault (OpenProject #2645). An expected reason gets the one `info` line
 * and nothing else; anything else — an uncaught exception routed through graceful-server's own
 * handler — keeps the `warn` with its stack.
 */
export function registerShutdownLogging(server: Pick<IGracefulServer, 'on'>): void {
  // -> Captured on the first event and read on the second, rather than recomputed: the two handlers
  //    are the only readers, one shutdown happens per process, and `stop()` is idempotent (it
  //    returns early once already shutting down), so there is nothing to key this by.
  let shutdownStartedAt: number | null = null

  server.on(gracefulServer.SHUTTING_DOWN, (err?: Error) => {
    shutdownStartedAt = Date.now()
    WIKI.logger.info('boot', 'stopping', {
      reason: err?.message ?? PROGRAMMATIC_SHUTDOWN_REASON
    })
    if (err && !EXPECTED_SHUTDOWN_REASONS.has(err.message)) {
      WIKI.logger.warn('boot', 'shutdown reason was not an expected signal', { error: err })
    }
  })

  // -> Written synchronously, because graceful-server calls `process.exit()` on the very next
  //    statement after this event. Writes to stdout are synchronous for both pipes and TTYs on
  //    Linux and macOS, which is what keeps this line from being dropped under `docker logs`.
  server.on(gracefulServer.SHUTDOWN, () => {
    WIKI.logger.info('boot', 'stopped', {
      ms: shutdownStartedAt === null ? 0 : Date.now() - shutdownStartedAt
    })
  })
}

/**
 * The root `/favicon.ico` every browser requests unprompted, whatever `index.html`'s own
 * `<link rel="icon" href="/_site/current/favicon">` says — see
 * `frontend/scripts/generate-favicon.mjs`'s header comment for why that request exists at all.
 * `'favicon.ico'` is in `core/http/siteRouting.ts`'s `RESERVED_ROOT_FILES`, so it never falls
 * through to the app-shell fallback.
 *
 * A committed file under this backend's own `assets/branding/`, same as `controllers/site.ts`'s
 * `SITE_ASSET_FALLBACKS` and for the same reason (OpenProject #2611): resolved against
 * `WIKI.SERVERPATH`, not a `vite build` output directory that may be stale, missing, or (before this
 * fix) buffered once at process boot by the `fastify-favicon` plugin this replaced — which meant a
 * rebuilt icon needed a full restart to ever reach a request, on top of the same day-long,
 * never-revalidated cache header `replyWithFile` fixes for the rest of the branding fallbacks
 * (OpenProject #2724).
 */
export const ROOT_FAVICON_PATH = 'assets/branding/favicon.ico'

/** Same reasoning, and the same value, as `controllers/site.ts`'s `SITE_ASSET_CACHE`. */
const ROOT_FAVICON_CACHE = 'public, no-cache'

/**
 * The static surfaces served straight off disk: the root favicon, the frontend's build output under
 * `/_assets/`, and the compiled blocks under `/_blocks/`.
 *
 * Registered between `registerSecurity` and `registerSession` — where the mounts already sat, and
 * where they have to stay: Fastify runs plugins in registration order, so moving this call is a
 * behaviour change rather than a tidy-up.
 */
export function registerStaticAssets(app: FastifyInstance): void {
  app.get('/favicon.ico', async (req, reply) =>
    replyWithFile(req, reply, path.join(WIKI.SERVERPATH, ROOT_FAVICON_PATH), {
      cacheControl: ROOT_FAVICON_CACHE
    })
  )
  app.register(fastifyStatic, {
    prefix: '/_assets/',
    root: path.join(WIKI.ROOTPATH, 'assets/_assets'),
    index: false,
    maxAge: '7d',
    decorateReply: false,
    // -> Most of what's under `assets/_assets` is a vite build output named `[name]-[hash].[ext]`,
    //    whose bytes can never change under a given URL — those get the same far-future immutable
    //    header `controllers/thumb.ts`'s THUMB_CACHE already uses. The handful of unhashed entries
    //    (renderer.js, and the hand-authored fonts/icons/illustrations/storage/svg trees) fall
    //    through to the `maxAge: '7d'` default above instead.
    setHeaders(reply, filePath) {
      if (isHashedAssetFilename(path.basename(filePath))) {
        reply.header('Cache-Control', 'public, max-age=31536000, immutable')
      }
    }
  })

  // ----------------------------------------
  // Blocks
  // ----------------------------------------

  app.register(fastifyStatic, {
    prefix: '/_blocks/',
    root: path.join(WIKI.ROOTPATH, 'blocks/compiled'),
    index: false,
    maxAge: '1h'
  })
  // -> A custom block's code is a database row, not a file under `blocks/compiled` — served by
  //    `controllers/blocks.ts` instead, registered below with the other controllers. Its route has a
  //    literal `custom` segment, which the router matches ahead of this mount's wildcard.
}
