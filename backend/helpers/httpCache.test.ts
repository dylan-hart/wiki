import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { notModifiedOrPrepare } from './httpCache.ts'
import { listSourceFiles } from '../test/sourceFiles.ts'
import type { FastifyReply, FastifyRequest } from 'fastify'

function fakeExchange(ifNoneMatch?: string) {
  const headers: Record<string, unknown> = {}
  const sent: number[] = []
  const reply = {
    header(name: string, value: unknown) {
      headers[name] = value
      return reply
    },
    code(status: number) {
      sent.push(status)
      return reply
    },
    send() {
      return reply
    }
  }
  const req = { headers: { 'if-none-match': ifNoneMatch } }
  return {
    req: req as unknown as FastifyRequest,
    reply: reply as unknown as FastifyReply,
    headers,
    sent
  }
}

describe('notModifiedOrPrepare', () => {
  test('sets ETag, Cache-Control and nosniff, and returns false for a fresh request', () => {
    const { req, reply, headers, sent } = fakeExchange()
    const answered = notModifiedOrPrepare(req, reply, {
      etag: '"abc"',
      cacheControl: 'public, no-cache'
    })
    assert.equal(answered, false)
    assert.deepEqual(headers, {
      ETag: '"abc"',
      'Cache-Control': 'public, no-cache',
      'X-Content-Type-Options': 'nosniff'
    })
    assert.deepEqual(sent, [])
  })

  test('answers 304 and returns true when If-None-Match matches the ETag', () => {
    const { req, reply, headers, sent } = fakeExchange('"abc"')
    const answered = notModifiedOrPrepare(req, reply, {
      etag: '"abc"',
      cacheControl: 'private, no-cache'
    })
    assert.equal(answered, true)
    assert.deepEqual(sent, [304])
    // -> The validator headers go out on the 304 as well
    assert.equal(headers.ETag, '"abc"')
    assert.equal(headers['Cache-Control'], 'private, no-cache')
  })

  test('a stale If-None-Match is not a match', () => {
    const { req, reply, sent } = fakeExchange('"stale"')
    assert.equal(
      notModifiedOrPrepare(req, reply, { etag: '"abc"', cacheControl: 'public, no-cache' }),
      false
    )
    assert.deepEqual(sent, [])
  })

  test('omits nosniff when the caller opts out', () => {
    const { req, reply, headers } = fakeExchange()
    notModifiedOrPrepare(req, reply, {
      etag: '"abc"',
      cacheControl: 'public, no-cache',
      nosniff: false
    })
    assert.deepEqual(headers, { ETag: '"abc"', 'Cache-Control': 'public, no-cache' })
  })
})

const BACKEND_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * A bare `return` resolves an `async` handler's promise with `undefined`, and Fastify then writes the
 * same reply a second time whenever an async `onSend` hook is still in flight — which, thanks to
 * `@fastify/session`'s, is every reply this app serves. The mistake is invisible at the call site,
 * hence a scan; `api/locales.test.ts` proves the behaviour end-to-end on one route.
 *
 * Scoped to `api/` and `controllers/` because the rule is about a ROUTE HANDLER's resolved value:
 * `helpers/siteResolution.ts#siteEnabledPreHandler` is a callback-style `preHandler` whose bare
 * `return` is correct — it withholds `done()` rather than resolving a promise.
 *
 * Comment lines are skipped because prose writes `guardSiteEnabled()` with the parentheses too.
 */
describe('callers of a reply-sending helper return the reply', () => {
  const sourceFiles = ['api', 'controllers'].flatMap((dir) =>
    listSourceFiles(path.join(BACKEND_ROOT, dir), { ext: ['.ts'], skip: ['.test.ts', '.d.ts'] })
  )

  const isComment = (line: string) => /^\s*(\/\/|\/?\*)/.test(line)

  for (const helper of ['notModifiedOrPrepare', 'guardSiteEnabled']) {
    test(`every ${helper}() call site`, () => {
      const callSites: string[] = []

      for (const file of sourceFiles) {
        const relative = path.relative(BACKEND_ROOT, file)
        const lines = readFileSync(file, 'utf8').split('\n')

        lines.forEach((line, index) => {
          if (!line.includes(`${helper}(`)) {
            return
          }
          // -> Its own declaration is not a call site of itself
          if (isComment(line) || new RegExp(`\\bfunction\\s+${helper}\\(`).test(line)) {
            return
          }
          const where = `${relative}:${index + 1}`
          callSites.push(where)

          // -> From the call line itself, since the guard may be written on one line
          const answer = lines.slice(index).find((candidate) => /\breturn\b/.test(candidate))
          assert.match(
            answer ?? '',
            /\breturn reply\b/,
            `${where}: a true ${helper}() must be answered with \`return reply\`, not a bare \`return\``
          )
        })
      }

      // -> A rename that made this scan match nothing would otherwise pass silently
      assert.ok(
        callSites.length >= 5,
        `expected to find ${helper}() call sites to check, found ${callSites.length}`
      )
    })
  }
})
