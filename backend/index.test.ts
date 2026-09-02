import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, afterEach, before, beforeEach, describe, mock, test } from 'node:test'
import fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import fastifySensible from '@fastify/sensible'
import {
  isPublicRateLimitedPath,
  limitApiKey,
  limitApiRequests,
  limitPublicRequests
} from './helpers/rateLimit.ts'
import { isBearerAuthenticatedPath } from './helpers/apiKeySite.ts'
import { installTestWiki } from './test/mocks.ts'

let wikiHandle: { restore(): void }

/**
 * OpenProject #2274: `index.ts` itself runs its boot sequence at import time (`await preBoot()` etc.
 * at the bottom of the file), so it cannot be imported into a test the way an ordinary module can —
 * the same reason `helpers/rateLimit.test.ts`'s `limitApiKey` suite builds its own small fastify
 * instance rather than importing the real one. This file does the same for the two `onRequest` hooks
 * `index.ts` registers back to back: the pre-existing `/_api/`-scoped one and the new root-mounted
 * public-surface one, wired here exactly as `index.ts` wires them (same `req.url` prefix check, same
 * `isPublicRateLimitedPath` gate, same handlers), so the only thing under test is the wiring itself --
 * that a root-mounted public path now reaches a limiter at all, and that it reaches the NEW one, not
 * the `/_api/` one, with its own separately-accounted bucket.
 */
describe('rate limiter hook wiring (index.ts)', () => {
  let app: FastifyInstance
  let consume: ReturnType<typeof mock.fn>

  before(async () => {
    app = fastify()
    await app.register(fastifySensible)

    // -> Mirrors index.ts's two `onRequest` hooks, in the same order, using the same exported
    //    helpers -- see the two "General API Rate Limit" / "Public Surface Rate Limit" blocks there.
    app.addHook('onRequest', async (req, reply) => {
      if (!req.url.startsWith('/_api/')) {
        return
      }
      return limitApiRequests(req, reply)
    })
    app.addHook('onRequest', async (req, reply) => {
      const path = req.url.split('?')[0] ?? req.url
      if (!isPublicRateLimitedPath(path)) {
        return
      }
      return limitPublicRequests(req, reply)
    })

    app.get('/_api/pages', async () => ({ ok: true }))
    app.get('/sitemap.xml', async () => '<urlset></urlset>')
    app.get('/login', async () => ({ ok: true }))

    await app.ready()
  })

  after(async () => {
    await app.close()
  })

  beforeEach(() => {
    consume = mock.fn(async () => ({ allowed: true, hits: 1, retryAfter: 0 }))
    wikiHandle = installTestWiki({
      config: { security: { apiRateLimitEnabled: true, apiRateLimitMax: 300 } },
      models: { rateLimits: { consume } },
      logger: { debug: mock.fn() }
    })
  })

  afterEach(() => {
    wikiHandle.restore()
  })

  test('a request to a root-mounted public path reaches the public limiter', async () => {
    const res = await app.inject({ method: 'GET', url: '/sitemap.xml' })
    assert.equal(res.statusCode, 200)
    assert.equal(consume.mock.calls.length, 1)
    assert.equal(consume.mock.calls[0].arguments[0], 'public:ip:127.0.0.1')
  })

  test('a request to an untouched route (neither /_api/ nor a public path) reaches no limiter', async () => {
    const res = await app.inject({ method: 'GET', url: '/login' })
    assert.equal(res.statusCode, 200)
    assert.equal(consume.mock.calls.length, 0)
  })

  test('a root-mounted public path never reaches the /_api/ limiter', async () => {
    await app.inject({ method: 'GET', url: '/sitemap.xml' })
    assert.ok(
      consume.mock.calls.every((call) => (call.arguments[0] as string).startsWith('public:'))
    )
  })

  test("the public path's budget is accounted separately from /_api/'s", async () => {
    const hits = new Map<string, number>()
    consume.mock.mockImplementation(async (key: string, policy: any) => {
      const n = (hits.get(key) ?? 0) + 1
      hits.set(key, n)
      return { allowed: n <= policy.max, hits: n, retryAfter: n <= policy.max ? 0 : 60 }
    })
    ;(globalThis as any).WIKI.config.security.apiRateLimitMax = 1

    // First /_api/ request consumes the /_api/ bucket's one allowed slot.
    const firstApi = await app.inject({ method: 'GET', url: '/_api/pages' })
    assert.equal(firstApi.statusCode, 200)
    // A second /_api/ request is refused -- its bucket is now exhausted.
    const secondApi = await app.inject({ method: 'GET', url: '/_api/pages' })
    assert.equal(secondApi.statusCode, 429)

    // The public path, from the same caller, is on its own bucket and unaffected.
    const publicReq = await app.inject({ method: 'GET', url: '/sitemap.xml' })
    assert.equal(publicReq.statusCode, 200)
  })
})

/**
 * OpenProject #2339: `index.ts`'s "API Key Authentication" `onRequest` hook only ever looked for a
 * Bearer token when `req.url.startsWith('/_api/')`, so `req.apiKey` stayed null for every request to
 * `controllers/files.ts` (`/_files`), `controllers/site.ts` (`/_site`) and `controllers/thumb.ts`
 * (`/_thumb`) regardless of whether a valid token was sent — silently defeating those controllers'
 * own `enforceApiKeySite()` calls (`files.ts`, `site.ts`) and `actorForRequest()`-mediated site-pin
 * check (`thumb.ts`). Wired here exactly as `index.ts` wires it (same `isBearerAuthenticatedPath`
 * gate, same header parsing, same `WIKI.models.apiKeys.verify()` and `limitApiKey()` calls), so the
 * only thing under test is the wiring: that `req.apiKey` now actually gets populated on the three
 * newly-covered prefixes, and still doesn't on a route this fix deliberately leaves alone.
 */
describe('API-key population hook wiring (index.ts)', () => {
  let app: FastifyInstance
  let verifyCalls: string[]
  let verifyResult: any
  let verifyShouldThrow: boolean

  before(async () => {
    wikiHandle = installTestWiki({
      models: {
        apiKeys: {
          verify: async (token: string) => {
            verifyCalls.push(token)
            if (verifyShouldThrow) {
              throw new Error('Invalid or expired API key')
            }
            return verifyResult
          }
        },
        rateLimits: {
          consume: async () => ({ allowed: true, hits: 1, retryAfter: 0 })
        }
      },
      logger: { debug: () => {} }
    })

    app = fastify()
    await app.register(fastifySensible)
    app.decorateRequest('apiKey', null)

    // -> Mirrors index.ts's own "API Key Authentication" onRequest hook verbatim, using the same
    //    exported gate (`isBearerAuthenticatedPath`) and the same `limitApiKey` helper.
    app.addHook('onRequest', async (req, reply) => {
      if (!isBearerAuthenticatedPath(req.url)) {
        return
      }
      const header = req.headers.authorization
      if (!header?.startsWith('Bearer ')) {
        return
      }
      const token = header.slice('Bearer '.length).trim()
      if (!token) {
        return
      }
      try {
        ;(req as any).apiKey = await WIKI.models.apiKeys.verify(token)
      } catch (err: any) {
        return reply.unauthorized(err.message)
      }
      return limitApiKey(req, reply)
    })

    const echoApiKey = async (req: any) => ({ ok: true, apiKey: req.apiKey })
    app.get('/_files/some/asset.png', echoApiKey)
    app.get('/_site/current/logo', echoApiKey)
    app.get('/_thumb/some-id.webp', echoApiKey)
    // -> Deliberately NOT covered by this fix -- render.ts resolves no site and is never fetched
    //    with an API key; a plain route stands in for "everything else stays cookie-authenticated".
    app.get('/_render/', echoApiKey)
    app.get('/login', echoApiKey)

    await app.ready()
  })

  after(async () => {
    await app.close()
    wikiHandle.restore()
  })

  beforeEach(() => {
    verifyCalls = []
    verifyShouldThrow = false
    verifyResult = { id: 'key-1', permissions: ['read:pages'], siteId: 'site-a' }
  })

  for (const url of ['/_files/some/asset.png', '/_site/current/logo', '/_thumb/some-id.webp']) {
    test(`populates req.apiKey for a valid Bearer token against ${url}`, async () => {
      const res = await app.inject({
        method: 'GET',
        url,
        headers: { authorization: 'Bearer valid-token' }
      })
      assert.equal(res.statusCode, 200)
      assert.equal(verifyCalls.length, 1)
      assert.equal(verifyCalls[0], 'valid-token')
      assert.deepEqual(res.json().apiKey, verifyResult)
    })

    test(`refuses with 401 and never sets req.apiKey when the token is rejected, against ${url}`, async () => {
      verifyShouldThrow = true
      const res = await app.inject({
        method: 'GET',
        url,
        headers: { authorization: 'Bearer bad-token' }
      })
      assert.equal(res.statusCode, 401)
      assert.equal(verifyCalls.length, 1)
    })

    test(`leaves req.apiKey null with no Authorization header, against ${url}`, async () => {
      const res = await app.inject({ method: 'GET', url })
      assert.equal(res.statusCode, 200)
      assert.equal(verifyCalls.length, 0)
      assert.equal(res.json().apiKey, null)
    })
  }

  test('does not verify a Bearer token against /_render/, which carries no API key by design', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/_render/',
      headers: { authorization: 'Bearer valid-token' }
    })
    assert.equal(res.statusCode, 200)
    assert.equal(verifyCalls.length, 0)
    assert.equal(res.json().apiKey, null)
  })

  test('does not verify a Bearer token against an ordinary cookie-authenticated route', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/login',
      headers: { authorization: 'Bearer valid-token' }
    })
    assert.equal(res.statusCode, 200)
    assert.equal(verifyCalls.length, 0)
    assert.equal(res.json().apiKey, null)
  })
})

/**
 * OpenProject #2048: `WIKI.db = await dbManager.init()` used to run *before* `preBoot()`'s
 * `try` opened, and nothing in `backend/` installs an `unhandledRejection` handler -- so a
 * migration or connection failure at boot killed the process with a bare unhandled-rejection
 * stack instead of the same deliberate "Database Initialization Error" + `WIKI.logger.error` +
 * `process.exit(1)` every other preBoot failure (e.g. an empty settings table) already got.
 * Fixed by moving the `try` up to wrap the db init calls too.
 *
 * Exercised as a real `node backend` boot rather than by stubbing `dbManager.init()` in-process:
 * the bug was specifically about what happens at the process level *between* the two statements
 * that used to straddle the `try` -- there is nowhere inside this same `node --test` run to
 * reproduce "the process dies with an unhandled rejection" without actually taking the test
 * runner down with it. Pointing `DATABASE_URL` at a closed local port fails the connection
 * attempt immediately (`ECONNREFUSED`), so this stays fast despite spawning a real process.
 */

const repoRoot = path.resolve(import.meta.dirname, '..')

let configDir: string
let configFile: string

before(async () => {
  configDir = await mkdtemp(path.join(tmpdir(), 'wikijs-preboot-test-'))
  configFile = path.join(configDir, 'config.yml')
  // -> Everything else preBoot needs (db.schema, pool.min, ...) comes from the real backend/base.yml
  //    defaults; DATABASE_URL below overrides every db.* connection field regardless of what's here.
  await writeFile(configFile, 'port: 0\n')
})

after(async () => {
  await rm(configDir, { recursive: true, force: true })
})

test(
  'a failing dbManager.init() during preBoot logs one deliberate error and exits non-zero, with no unhandled-rejection stack',
  // -> `dbManager.connect()` retries a connection failure 10 times, 3s apart, before giving up and
  //    throwing (`core/db.ts`) -- unrelated to what this test verifies (what happens once it does
  //    give up), but it means a real boot against an unreachable database takes ~30s regardless.
  { timeout: 45000 },
  async () => {
    const child = spawn(
      process.execPath,
      [
        '--require',
        './backend/test/fixtures/spoofSupportedNodeVersion.cjs',
        '--require',
        './backend/test/fixtures/polyfillTemporalForSpawnedBoot.cjs',
        'backend'
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          CONFIG_FILE: configFile,
          // -> Port 1 on loopback: nothing ever listens there, so pg's connection attempt fails
          //    immediately with ECONNREFUSED rather than timing out.
          DATABASE_URL: 'postgres://wiki:wiki@127.0.0.1:1/wiki',
          WIKI_PORT: '0'
        }
      }
    )

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })

    const exitCode = await new Promise<number | null>((resolve) => {
      child.on('exit', (code) => resolve(code))
    })

    const output = stdout + stderr

    assert.notEqual(
      exitCode,
      0,
      `expected a non-zero exit code, got ${exitCode}\n--- output ---\n${output}`
    )
    assert.match(
      output,
      /Database Initialization Error/,
      `expected the deliberate error message in the output\n--- output ---\n${output}`
    )
    assert.doesNotMatch(
      output,
      /Unhandled(Promise)?Rejection/i,
      `expected no unhandled-rejection stack in the output\n--- output ---\n${output}`
    )
  }
)

/**
 * `backend/index.ts` is the real process entry point: importing it runs the whole boot sequence
 * (`preBoot()` → `initHTTPServer()` → `postBoot()`) as top-level, side-effecting code against a real
 * Postgres connection and a real bound HTTP listener. That makes it unsafe -- and far from "fast and
 * scoped" -- to exercise by actually importing the module in a unit test. So this test locks down the
 * boot-ordering contract structurally, against the file's own source text, the same way the sibling
 * docs-*.test.ts files in this directory lock down structural properties of otherwise-unexecutable
 * targets.
 *
 * Regression coverage for OpenProject #2062: `WIKI.server.setReady()` must not fire until `postBoot()`
 * has resolved. `postBoot()` is what actually makes the instance able to answer a page request --
 * `sites.reloadCache()` in particular, without which every request resolves to `not-found`. Signalling
 * ready any earlier (the old behavior: the last statement of `initHTTPServer()`, right after the
 * listener binds) meant `/_ready` reported 200 throughout that whole window.
 *
 * `postBoot()` itself is invoked through `runBootPhaseOrExit()` (OpenProject #2065), which either
 * resolves after `postBoot()` succeeds or calls `process.exit(1)` -- so a module-level statement
 * placed after that call is only ever reached on success, and the ordering assertions below key off
 * `runBootPhaseOrExit(postBoot,` rather than a literal `await postBoot()`.
 */

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const indexTs = readFileSync(path.join(REPO_ROOT, 'backend/index.ts'), 'utf8')

/**
 * Extracts the balanced-brace body of `async function <name>() { ... }`, by counting braces from the
 * opening one, so a test can inspect one function's contents without matching text that happens to
 * live in a neighboring function.
 */
function extractFunctionBody(source: string, name: string): string {
  const header = `async function ${name}() {`
  const start = source.indexOf(header)
  assert.notEqual(start, -1, `expected to find "${header}" in backend/index.ts`)
  let depth = 1
  let i = start + header.length
  for (; i < source.length && depth > 0; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') depth--
  }
  return source.slice(start + header.length, i - 1)
}

describe('backend/index.ts boot sequence (OpenProject #2062)', () => {
  test('initHTTPServer() no longer calls WIKI.server.setReady()', () => {
    const body = extractFunctionBody(indexTs, 'initHTTPServer')
    assert.doesNotMatch(body, /setReady/)
  })

  test('the module-level sequence calls setReady() only after preBoot(), initHTTPServer() and postBoot() have all been awaited, in that order', () => {
    const preBootIdx = indexTs.indexOf('await preBoot()')
    const initHTTPServerIdx = indexTs.indexOf('await initHTTPServer()')
    const postBootIdx = indexTs.indexOf('runBootPhaseOrExit(postBoot,')
    const setReadyIdx = indexTs.lastIndexOf('WIKI.server.setReady()')

    assert.notEqual(preBootIdx, -1, 'expected a module-level `await preBoot()`')
    assert.notEqual(initHTTPServerIdx, -1, 'expected a module-level `await initHTTPServer()`')
    assert.notEqual(
      postBootIdx,
      -1,
      'expected a module-level `await runBootPhaseOrExit(postBoot, ...)`'
    )
    assert.notEqual(setReadyIdx, -1, 'expected a module-level `WIKI.server.setReady()` call')

    assert.ok(preBootIdx < initHTTPServerIdx, 'preBoot() must be awaited before initHTTPServer()')
    assert.ok(initHTTPServerIdx < postBootIdx, 'initHTTPServer() must be awaited before postBoot()')
    assert.ok(
      postBootIdx < setReadyIdx,
      'setReady() must come after postBoot() has been awaited, not before'
    )
  })

  test('setReady() is the final statement of the boot sequence, with nothing after it', () => {
    const setReadyIdx = indexTs.lastIndexOf('WIKI.server.setReady()')
    const trailing = indexTs.slice(setReadyIdx + 'WIKI.server.setReady()'.length)
    // Only whitespace (and an optional trailing newline) should remain in the file after it.
    assert.match(trailing, /^\s*$/)
  })
})
