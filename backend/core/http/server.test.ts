import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { after, before, describe, mock, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import gracefulServer from '@gquittet/graceful-server'
import {
  createHttpApp,
  pinoStreamToWikiLogger,
  registerShutdownLogging,
  registerStaticAssets
} from './server.ts'
import { registerErrorHandler } from './errors.ts'
import { createSilentLogger, installTestWiki } from '../../test/mocks.ts'

/**
 * The Fastify instance itself was built inline in `index.ts` until this split, which is why none of
 * it had a test: the only way to reach that code was to boot the whole process. `createHttpApp()`
 * makes the options block, the `@fastify/sensible` / `@fastify/compress` / `@fastify/websocket`
 * registrations and the graceful-shutdown wiring reachable without a listening socket — `inject()`
 * never binds one — so the settings that decide how every request is parsed and routed can be
 * asserted directly rather than inferred from an e2e failure.
 *
 * `registerStaticAssets()` is the other half: three mounts whose ORDER relative to
 * `registerSecurity`/`registerSession` is behaviour (Fastify registers plugins in call order), and
 * whose `/_assets/` mount carries the immutable-cache rule `helpers/common.ts#isHashedAssetFilename`
 * decides. Driven here against a throwaway `WIKI.ROOTPATH` laid out the way a built checkout is,
 * since `fastify-favicon` refuses to register at all without a real `assets/favicon.ico`.
 */

/** The minimum `WIKI` global `createHttpApp()` and `registerStaticAssets()` actually read. */
function installWikiStub({
  rootPath = process.cwd(),
  logger,
  ...config
}: { rootPath?: string; logger?: any } & Record<string, any> = {}) {
  const previous = (globalThis as any).WIKI
  installTestWiki({
    INSTANCE_ID: 'test-instance',
    ROOTPATH: rootPath,
    sitesMappings: {},
    ...(logger ? { logger } : {}),
    config: {
      bodyParserLimit: 0,
      logFormat: 'text',
      security: { trustProxy: false },
      ...config
    }
  })
  return () => {
    ;(globalThis as any).WIKI = previous
  }
}

/** One captured `WIKI.logger` call, in whichever of the two shapes the caller used. */
interface RecordedLine {
  level: 'error' | 'warn' | 'info' | 'debug'
  /** The new shape's scope — or, for a legacy `(msg, context?)` call, the message itself. */
  scope: unknown
  /** The new shape's message — or, for a legacy call, the context object. */
  message: unknown
  fields: Record<string, unknown>
}

/**
 * A `WIKI.logger` that keeps what it was told rather than printing it.
 *
 * `createSilentLogger()` throws each call away, which is right for a suite that only needs the
 * logger to exist; the access line IS what is under test here, so it has to be readable back.
 */
function createRecordingLogger(): { lines: RecordedLine[]; logger: any } {
  const lines: RecordedLine[] = []
  const at =
    (level: RecordedLine['level']) =>
    (scope: unknown, message?: unknown, fields?: Record<string, unknown>) => {
      lines.push({ level, scope, message, fields: fields ?? {} })
    }
  const logger: any = { error: at('error'), warn: at('warn'), info: at('info'), debug: at('debug') }
  logger.scope = () => logger
  return { lines, logger }
}

/** The `http`-scoped lines a recording logger captured, in order. */
function httpLines(lines: RecordedLine[]): RecordedLine[] {
  return lines.filter((line) => line.scope === 'http')
}

describe('createHttpApp', () => {
  let restoreWiki: () => void
  let app: FastifyInstance

  before(async () => {
    restoreWiki = installWikiStub()
    app = createHttpApp()
    // -> Pino writes an access line per request to stdout; nothing here is asserting on logs, so
    //    silence the instance rather than interleaving them with the test runner's own output.
    app.log.level = 'silent'
    app.get('/echo', async (req, reply) => {
      // -> `reply.notFound` is @fastify/sensible's; reaching for it here is the assertion that the
      //    plugin registered, since every route in `api/` answers its errors through it.
      if ((req.query as { fail?: string }).fail) {
        return reply.notFound('nope')
      }
      return { ok: true }
    })
    await app.ready()
  })

  after(async () => {
    await app.close()
    restoreWiki()
  })

  test('assigns WIKI.app and WIKI.server, so the boot script can listen and flip readiness', () => {
    assert.equal((globalThis as any).WIKI.app, app)
    assert.equal(typeof (globalThis as any).WIKI.server.setReady, 'function')
  })

  test('registers @fastify/sensible, so reply.notFound() is available to every route', async () => {
    const res = await app.inject({ method: 'GET', url: '/echo?fail=1' })
    assert.equal(res.statusCode, 404)
    assert.equal(res.json().message, 'nope')
  })

  test('ignores a trailing slash, so /page and /page/ are one route', async () => {
    const res = await app.inject({ method: 'GET', url: '/echo/' })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), { ok: true })
  })
})

describe("createHttpApp: the ajv 'hexcolor' format", () => {
  let restoreWiki: () => void
  let app: FastifyInstance

  before(async () => {
    restoreWiki = installWikiStub()
    app = createHttpApp()
    // -> Pino writes an access line per request to stdout; nothing here is asserting on logs, so
    //    silence the instance rather than interleaving them with the test runner's own output.
    app.log.level = 'silent'
    app.post<{ Body: { color: string } }>(
      '/color',
      {
        schema: {
          body: {
            type: 'object',
            required: ['color'],
            properties: { color: { type: 'string', format: 'hexcolor' } }
          }
        }
      },
      async () => ({ ok: true })
    )
    await app.ready()
  })

  after(async () => {
    await app.close()
    restoreWiki()
  })

  for (const color of ['#abc', '#abcd', '#aabbcc', '#aabbccdd']) {
    test(`accepts ${color}, one of the four forms a color picker produces`, async () => {
      const res = await app.inject({ method: 'POST', url: '/color', payload: { color } })
      assert.equal(res.statusCode, 200)
    })
  }

  test('refuses anything that is not one of those four forms', async () => {
    for (const color of ['rebeccapurple', '#ab', '#aabbc', 'aabbcc']) {
      const res = await app.inject({ method: 'POST', url: '/color', payload: { color } })
      assert.equal(res.statusCode, 400, `expected ${color} to be refused`)
    }
  })
})

/**
 * The access log (OpenProject #2662).
 *
 * Pino used to write `incoming request` / `request completed` per request straight to stdout, in its
 * own JSON shape, reaching neither the terminal backlog nor the app's own format. `createHttpApp()`
 * now sets `disableRequestLogging` and registers one `onResponse` hook instead, so every request
 * produces exactly one `http`-scoped line on `WIKI.logger` — and pino keeps only Fastify's own
 * diagnostics, re-emitted through the same logger by the sidecar stream below.
 */
describe('createHttpApp: the http access line', () => {
  /** Boots an app with a recording logger and a handful of routes covering each status band. */
  async function withApp(
    run: (app: FastifyInstance, lines: RecordedLine[]) => Promise<void>
  ): Promise<void> {
    const { lines, logger } = createRecordingLogger()
    const restoreWiki = installWikiStub({ logger })
    const app = createHttpApp()
    // -> The real error handler, not a replica: the 500 case below asserts that its line and the
    //    access line carry the same `reqId`, which is only meaningful against the production one.
    registerErrorHandler(app)
    app.get('/_api/ok', async () => ({ ok: true }))
    app.get('/_api/missing', async (_req, reply) => reply.notFound('nope'))
    app.get('/_api/boom', async () => {
      throw new Error('handler exploded')
    })
    await app.ready()
    try {
      await run(app, lines)
    } finally {
      await app.close()
      restoreWiki()
    }
  }

  test('a 200 emits exactly one debug http line, carrying reqId, ms and ip', async () => {
    await withApp(async (app, lines) => {
      const res = await app.inject({ method: 'GET', url: '/_api/ok' })
      assert.equal(res.statusCode, 200)

      const access = httpLines(lines)
      assert.equal(access.length, 1, 'one line per request, not pino’s incoming/completed pair')
      assert.equal(access[0].level, 'debug')
      assert.equal(access[0].message, 'GET /_api/ok → 200')
      assert.equal(typeof access[0].fields.reqId, 'string')
      assert.equal(typeof access[0].fields.ms, 'number', 'ms is a number, not a formatted string')
      assert.equal(typeof access[0].fields.ip, 'string')
    })
  })

  test('a 404 is a warn, so a refusal stays visible above the debug traffic', async () => {
    await withApp(async (app, lines) => {
      const res = await app.inject({ method: 'GET', url: '/_api/missing' })
      assert.equal(res.statusCode, 404)

      const access = httpLines(lines)
      assert.equal(access.length, 1)
      assert.equal(access[0].level, 'warn')
      assert.equal(access[0].message, 'GET /_api/missing → 404')
    })
  })

  test('a thrown handler emits the access line at error, sharing reqId with the 500', async () => {
    await withApp(async (app, lines) => {
      const res = await app.inject({ method: 'GET', url: '/_api/boom' })
      assert.equal(res.statusCode, 500)

      // -> Two `http` lines for one request, deliberately: the access record here, and the
      //    exception with its stack from `helpers/errorHandler.ts` — which logs on the same scope,
      //    so they are told apart by their message, not by the shape of the call. `reqId` is what
      //    joins them.
      const http = httpLines(lines)
      assert.equal(http.length, 2)

      const access = http.filter((line) => line.message === 'GET /_api/boom → 500')
      assert.equal(
        access.length,
        1,
        'one access line per request, not pino’s incoming/completed pair'
      )
      assert.equal(access[0].level, 'error')

      const fromErrorHandler = http.find((line) => line.message === 'unhandled error, answered 500')
      assert.ok(fromErrorHandler, 'the error handler logged the exception itself')
      assert.ok(fromErrorHandler.fields.error instanceof Error)
      assert.equal(fromErrorHandler.fields.reqId, access[0].fields.reqId)
    })
  })

  test('carries the authenticated userId, and the site a site-scoped route resolved', async () => {
    const { lines, logger } = createRecordingLogger()
    const restoreWiki = installWikiStub({ logger })
    const app = createHttpApp()
    app.get('/_api/sites/:siteId/thing', async (req) => {
      req.session = { authenticated: true, user: { id: 'user-9' } } as any
      return { ok: true }
    })
    await app.ready()
    try {
      await app.inject({ method: 'GET', url: '/_api/sites/site-7/thing' })
      const access = httpLines(lines)
      assert.equal(access.length, 1)
      assert.equal(access[0].fields.siteId, 'site-7')
      assert.equal(access[0].fields.userId, 'user-9')
    } finally {
      await app.close()
      restoreWiki()
    }
  })
})

describe('createHttpApp: pino no longer reaches stdout', () => {
  /**
   * Captures `process.stdout.write` while still forwarding it, so the runner's own output survives.
   *
   * "Nothing reaches stdout" would be false — `WIKI.logger` itself prints there. What the acceptance
   * criterion actually means is that no PINO record does, which is what the `{"level":<n>` prefix
   * of pino's default JSON line identifies.
   */
  async function captureStdout(run: () => Promise<void>): Promise<string[]> {
    const captured: string[] = []
    const original = process.stdout.write.bind(process.stdout)
    ;(process.stdout as any).write = (chunk: any, ...rest: any[]) => {
      captured.push(String(chunk))
      return (original as any)(chunk, ...rest)
    }
    try {
      await run()
    } finally {
      ;(process.stdout as any).write = original
    }
    return captured
  }

  const PINO_RECORD = /^\{"level":\d/

  test('a served request writes no pino record to stdout', async () => {
    const { logger } = createRecordingLogger()
    const restoreWiki = installWikiStub({ logger })
    const app = createHttpApp()
    app.get('/echo', async () => ({ ok: true }))
    await app.ready()
    try {
      const captured = await captureStdout(async () => {
        await app.inject({ method: 'GET', url: '/echo' })
      })
      assert.ok(
        !captured.some((chunk) => PINO_RECORD.test(chunk)),
        `expected no pino record on stdout, saw: ${JSON.stringify(captured)}`
      )
    } finally {
      await app.close()
      restoreWiki()
    }
  })

  test("Fastify's own diagnostics are re-emitted as http lines instead of printed", async () => {
    const { lines, logger } = createRecordingLogger()
    const restoreWiki = installWikiStub({ logger })
    const app = createHttpApp()
    await app.ready()
    try {
      const captured = await captureStdout(async () => {
        app.log.warn({ reqId: 'req-42' }, 'Reply was already sent')
        app.log.error({ err: new Error('boom') }, 'FST_ERR_SEND_INSIDE_ONERR')
      })

      assert.ok(!captured.some((chunk) => PINO_RECORD.test(chunk)))

      const [warned, errored] = httpLines(lines)
      assert.equal(warned.level, 'warn')
      assert.equal(warned.message, 'Reply was already sent')
      assert.equal(warned.fields.reqId, 'req-42')

      // -> Severity is carried across rather than flattened: an FST_ERR_* stays an error.
      assert.equal(errored.level, 'error')
      assert.equal(errored.message, 'FST_ERR_SEND_INSIDE_ONERR')
      assert.ok(errored.fields.error instanceof Error)
      assert.equal((errored.fields.error as Error).message, 'boom')
    } finally {
      await app.close()
      restoreWiki()
    }
  })
})

describe('pinoStreamToWikiLogger', () => {
  test('drops a malformed record rather than throwing inside Fastify’s error path', () => {
    const { lines, logger } = createRecordingLogger()
    const restoreWiki = installWikiStub({ logger })
    try {
      const stream = pinoStreamToWikiLogger()
      assert.doesNotThrow(() => stream.write('not json at all'))
      assert.doesNotThrow(() => stream.write('{"level":40}'))
      assert.equal(lines.length, 0, 'a record with no msg says nothing worth emitting')
    } finally {
      restoreWiki()
    }
  })
})

describe('registerStaticAssets', () => {
  let restoreWiki: () => void
  let app: FastifyInstance
  let rootPath: string

  before(async () => {
    rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-static-'))
    fs.mkdirSync(path.join(rootPath, 'assets/_assets'), { recursive: true })
    fs.mkdirSync(path.join(rootPath, 'blocks/compiled'), { recursive: true })
    fs.writeFileSync(path.join(rootPath, 'assets/favicon.ico'), 'icon-bytes')
    fs.writeFileSync(path.join(rootPath, 'assets/_assets/index-CL_uwIZr.js'), 'hashed')
    fs.writeFileSync(path.join(rootPath, 'assets/_assets/renderer.js'), 'unhashed')
    fs.writeFileSync(path.join(rootPath, 'blocks/compiled/block-map.js'), 'block')

    restoreWiki = installWikiStub({ rootPath })
    app = createHttpApp()
    // -> Pino writes an access line per request to stdout; nothing here is asserting on logs, so
    //    silence the instance rather than interleaving them with the test runner's own output.
    app.log.level = 'silent'
    registerStaticAssets(app)
    await app.ready()
  })

  after(async () => {
    await app.close()
    restoreWiki()
    fs.rmSync(rootPath, { recursive: true, force: true })
  })

  test('serves the root favicon', async () => {
    const res = await app.inject({ method: 'GET', url: '/favicon.ico' })
    assert.equal(res.statusCode, 200)
  })

  test('serves a hashed build output under /_assets/ as immutable', async () => {
    const res = await app.inject({ method: 'GET', url: '/_assets/index-CL_uwIZr.js' })
    assert.equal(res.statusCode, 200)
    assert.equal(res.headers['cache-control'], 'public, max-age=31536000, immutable')
  })

  test('serves an unhashed /_assets/ entry on the plain 7d default instead', async () => {
    const res = await app.inject({ method: 'GET', url: '/_assets/renderer.js' })
    assert.equal(res.statusCode, 200)
    assert.equal(res.headers['cache-control'], 'public, max-age=604800')
  })

  test('serves a compiled block under /_blocks/', async () => {
    const res = await app.inject({ method: 'GET', url: '/_blocks/block-map.js' })
    assert.equal(res.statusCode, 200)
    assert.equal(res.headers['cache-control'], 'public, max-age=3600')
  })
})

describe('registerShutdownLogging', () => {
  /**
   * Drives the real event names against a bare `EventEmitter` — `IGracefulServer.on` is
   * `(name, callback) => EventEmitter`, so an emitter satisfies the parameter structurally and the
   * handlers run exactly as the library calls them, with no process signalling involved.
   *
   * Both events, in the order graceful-server emits them: `SHUTTING_DOWN` with the reason at the top
   * of `stop()`, then `SHUTDOWN` once the pre-close delay, the `closePromises` and the socket close
   * are all done. `emitShuttingDownOnly` covers the first half alone.
   */
  function emitShutdown(reason?: Error) {
    const { info, warn, server, restore } = startShutdown(reason)
    try {
      server.emit(gracefulServer.SHUTDOWN, reason)
      return { info, warn }
    } finally {
      restore()
    }
  }

  function startShutdown(reason?: Error) {
    const info = mock.fn()
    const warn = mock.fn()
    const wiki = installTestWiki({ logger: { ...createSilentLogger(), info, warn } })
    const server = new EventEmitter()
    registerShutdownLogging(server)
    server.emit(gracefulServer.SHUTTING_DOWN, reason)
    return { info, warn, server, restore: () => wiki.restore() }
  }

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    test(`${signal} is an ordinary shutdown: stopping then stopped, no warning and no stack`, () => {
      const { info, warn } = emitShutdown(new Error(signal))
      assert.equal(info.mock.callCount(), 2)
      assert.deepEqual(info.mock.calls[0].arguments, ['boot', 'stopping', { reason: signal }])
      assert.equal(warn.mock.callCount(), 0)
    })
  }

  test('the stopped line carries `ms`, as a number, so the renderer prints it as a duration', () => {
    const { info } = emitShutdown(new Error('SIGTERM'))
    const [scope, message, fields] = info.mock.calls[1].arguments as [
      string,
      string,
      { ms: number }
    ]
    assert.equal(scope, 'boot')
    assert.equal(message, 'stopped')
    assert.equal(typeof fields.ms, 'number')
    assert.ok(fields.ms >= 0)
  })

  test('stopping is emitted when the teardown starts, not when it ends', () => {
    // -> The whole point of the split: graceful-server runs its pre-close delay, `closePromises`
    //    (scheduler drain, collab close, db pool end) and the socket close BETWEEN the two events,
    //    so a `stopping` line on SHUTDOWN would appear only after all of that had already happened
    //    and `ms` would be measured against nothing.
    const { info, server, restore } = startShutdown(new Error('SIGTERM'))
    try {
      assert.equal(info.mock.callCount(), 1)
      assert.deepEqual(info.mock.calls[0].arguments, ['boot', 'stopping', { reason: 'SIGTERM' }])
      server.emit(gracefulServer.SHUTDOWN, new Error('SIGTERM'))
      assert.equal(info.mock.callCount(), 2)
      assert.equal(info.mock.calls[1].arguments[1], 'stopped')
    } finally {
      restore()
    }
  })

  test('any other reason still warns with the error itself, stack included', () => {
    const boom = new Error('boom')
    const { info, warn } = emitShutdown(boom)
    assert.equal(info.mock.callCount(), 2)
    assert.equal(warn.mock.callCount(), 1)
    assert.equal(warn.mock.calls[0].arguments[0], 'boot')
    // -> The `Error` itself under `fields.error`, so the renderer prints its message and its stack.
    assert.equal((warn.mock.calls[0].arguments[2] as { error: Error }).error, boom)
  })

  test('a message merely containing a signal name is not exempted', () => {
    // -> The reason is matched exactly, not by prefix or substring: graceful-server sets
    //    `new Error(<signal>)`, so a longer message is a real fault rather than a clean exit.
    const { warn } = emitShutdown(new Error('SIGTERM handler failed'))
    assert.equal(warn.mock.callCount(), 1)
  })

  test('a programmatic stop, which carries no Error at all, is reported but not warned about', () => {
    // -> `WIKI.server.stop()` passes graceful-server neither a `type` nor a `body`, so it emits
    //    both events with `undefined`. That is a deliberate shutdown, not an unexpected signal.
    const { info, warn } = emitShutdown(undefined)
    assert.deepEqual(info.mock.calls[0].arguments, ['boot', 'stopping', { reason: 'programmatic' }])
    assert.equal(warn.mock.callCount(), 0)
  })
})
