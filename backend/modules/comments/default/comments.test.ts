import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, it, mock } from 'node:test'
import { load } from 'js-yaml'
import { parseModuleProps } from '../../../helpers/moduleProps.ts'
import { createSilentLogger, installTestWiki } from '../../../test/mocks.ts'
import commentsDefaultModule, {
  _resetAkismetClientCacheForTesting,
  _setAkismetClientFactoryForTesting,
  checkRateLimit
} from './comments.ts'
import type { CheckSpamParams } from './comments.ts'

/**
 * `checkSpam` reads `WIKI.config.host` (the Akismet "blog" identity, matching 2.5.x) and
 * `WIKI.logger.warn` (fail-open logging) — a minimal stub of just those two, not the full
 * `test/db.ts` fixture, since nothing here touches the database. `warnLog` collects every warning so
 * tests can assert on the fail-open message without asserting on real log formatting.
 */
const warnLog: string[] = []
installTestWiki({
  config: { host: 'https://test.wiki' },
  // -> Not the silent default: tests assert on the fail-open warning this module emits.
  logger: { ...createSilentLogger(), warn: (msg: string) => warnLog.push(msg) }
})

/**
 * Minimal stand-in for the subset of `Temporal` `checkRateLimit` and this file's own fixtures use
 * (`Now.instant()`, `Instant.compare()`, `.add()`/`.subtract()`).
 *
 * CLAUDE.md documents `Temporal` as a Node 26 global needing no import, but this sandbox's `node` is
 * v25.9.0, which doesn't expose it — the same environment gap `core/scheduler.test.ts` works around,
 * not a spec deviation. `Instant.compare` implements the real (a, b) => sign(a - b) semantics, so
 * `checkRateLimit`'s actual comparison logic is exercised, not a re-implementation of it.
 */
if (typeof (globalThis as any).Temporal === 'undefined') {
  const durationToMs = (d: { seconds?: number }) => (d.seconds ?? 0) * 1_000
  const makeInstant = (epochMs: number): any => ({
    epochMilliseconds: epochMs,
    add: (d: any) => makeInstant(epochMs + durationToMs(d)),
    subtract: (d: any) => makeInstant(epochMs - durationToMs(d)),
    toString: () => new Date(epochMs).toISOString()
  })
  ;(globalThis as any).Temporal = {
    Now: { instant: () => makeInstant(Date.now()) },
    Instant: {
      compare: (a: any, b: any) => Math.sign(a.epochMilliseconds - b.epochMilliseconds)
    }
  }
}

function baseSpamParams(overrides: Partial<CheckSpamParams> = {}): CheckSpamParams {
  return {
    ip: '203.0.113.5',
    userAgent: 'Mozilla/5.0 (Test)',
    content: 'Nice post!',
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    permalink: 'https://test.wiki/en/some-page',
    permalinkDate: '2026-08-16T00:00:00.000Z',
    type: 'comment',
    role: 'user',
    ...overrides
  }
}

describe('modules/comments/default', () => {
  describe('comments.ts', () => {
    afterEach(() => {
      warnLog.length = 0
      _resetAkismetClientCacheForTesting()
      _setAkismetClientFactoryForTesting(null)
    })

    it('is importable and exposes the CommentProviderModule contract', () => {
      assert.equal(typeof commentsDefaultModule.render, 'function')
      assert.equal(typeof commentsDefaultModule.checkSpam, 'function')
      assert.equal(typeof commentsDefaultModule.checkRateLimit, 'function')
    })

    describe('checkRateLimit', () => {
      const now = Temporal.Now.instant()

      it('allows a first post: no prior comment at all', () => {
        assert.equal(checkRateLimit(30, undefined, now), true)
        assert.equal(checkRateLimit(30, null, now), true)
      })

      it('disables rate limiting entirely when minDelay is 0', () => {
        const justNow = now.subtract({ seconds: 1 })
        assert.equal(checkRateLimit(0, justNow, now), true)
      })

      it('disallows a post strictly inside the configured window', () => {
        const fiveSecondsAgo = now.subtract({ seconds: 5 })
        assert.equal(checkRateLimit(30, fiveSecondsAgo, now), false)
      })

      it('disallows a post exactly at the boundary minus one instant (still too soon)', () => {
        const justUnderThirty = now.subtract({ seconds: 29 })
        assert.equal(checkRateLimit(30, justUnderThirty, now), false)
      })

      it('allows a post exactly at the boundary (cutoff reached, not just passed)', () => {
        const exactlyThirtyAgo = now.subtract({ seconds: 30 })
        assert.equal(checkRateLimit(30, exactlyThirtyAgo, now), true)
      })

      it('allows a post once the window has fully elapsed', () => {
        const anHourAgo = now.subtract({ seconds: 3600 })
        assert.equal(checkRateLimit(30, anHourAgo, now), true)
      })

      it('is a pure function of its arguments: same inputs, same output, no side effects', () => {
        const twentyAgo = now.subtract({ seconds: 20 })
        assert.equal(checkRateLimit(30, twentyAgo, now), checkRateLimit(30, twentyAgo, now))
      })

      it('module.checkRateLimit reads minDelay off conf and delegates to the pure function', async () => {
        const tenAgo = now.subtract({ seconds: 10 })
        assert.equal(
          await commentsDefaultModule.checkRateLimit({ lastCommentAt: tenAgo }, { minDelay: 30 }),
          false
        )
        assert.equal(
          await commentsDefaultModule.checkRateLimit({ lastCommentAt: tenAgo }, { minDelay: 5 }),
          true
        )
      })

      it('module.checkRateLimit treats a missing/non-numeric minDelay as disabled (0)', async () => {
        const tenAgo = now.subtract({ seconds: 10 })
        assert.equal(
          await commentsDefaultModule.checkRateLimit({ lastCommentAt: tenAgo }, {}),
          true
        )
      })

      it("guest pooling is the caller's job: two different callers sharing one lastCommentAt are rate-limited together", () => {
        // -> This module has no notion of "guest" — it only ever compares the instant it is handed.
        //    Simulating guest pooling here means two logically-different posters (e.g. two different
        //    IPs) resolving to the SAME shared bucket timestamp, which is exactly what the caller is
        //    responsible for doing (see CheckRateLimitParams' JSDoc) before calling this function.
        const sharedGuestBucketLastCommentAt = now.subtract({ seconds: 2 })
        const guestPosterOneAllowed = checkRateLimit(30, sharedGuestBucketLastCommentAt, now)
        const guestPosterTwoAllowed = checkRateLimit(30, sharedGuestBucketLastCommentAt, now)
        assert.equal(guestPosterOneAllowed, false)
        assert.equal(guestPosterTwoAllowed, false)
      })
    })

    describe('checkSpam', () => {
      it('is a no-op (not spam, no client, no warning) when conf.akismet is empty', async () => {
        const factory = mock.fn(() => {
          throw new Error('should never be called when the key is empty')
        })
        _setAkismetClientFactoryForTesting(factory)

        const result = await commentsDefaultModule.checkSpam(baseSpamParams(), { akismet: '' })

        assert.deepEqual(result, { isSpam: false })
        assert.equal(factory.mock.callCount(), 0)
        assert.deepEqual(warnLog, [])
      })

      it('is a no-op when the akismet prop is left unset entirely', async () => {
        const result = await commentsDefaultModule.checkSpam(baseSpamParams(), {})
        assert.deepEqual(result, { isSpam: false })
      })

      it('returns isSpam: true when Akismet reports the comment as spam', async () => {
        _setAkismetClientFactoryForTesting(() => ({
          verifyKey: async () => true,
          checkSpam: async () => true
        }))

        const result = await commentsDefaultModule.checkSpam(baseSpamParams(), {
          akismet: 'valid-key'
        })

        assert.deepEqual(result, { isSpam: true })
      })

      it('returns isSpam: false when Akismet reports the comment as ham', async () => {
        _setAkismetClientFactoryForTesting(() => ({
          verifyKey: async () => true,
          checkSpam: async () => false
        }))

        const result = await commentsDefaultModule.checkSpam(baseSpamParams(), {
          akismet: 'valid-key'
        })

        assert.deepEqual(result, { isSpam: false })
      })

      it('passes the full field set (mapped to akismet-api names) through to the client', async () => {
        let received: any = null
        _setAkismetClientFactoryForTesting(() => ({
          verifyKey: async () => true,
          checkSpam: async (comment) => {
            received = comment
            return false
          }
        }))

        await commentsDefaultModule.checkSpam(
          baseSpamParams({ type: 'reply', role: 'administrator' }),
          { akismet: 'valid-key' }
        )

        assert.deepEqual(received, {
          ip: '203.0.113.5',
          useragent: 'Mozilla/5.0 (Test)',
          content: 'Nice post!',
          name: 'Ada Lovelace',
          email: 'ada@example.com',
          permalink: 'https://test.wiki/en/some-page',
          permalinkDate: '2026-08-16T00:00:00.000Z',
          type: 'reply',
          role: 'administrator'
        })
      })

      it('constructs the client with the akismet key and WIKI.config.host as the blog', async () => {
        let receivedOpts: any = null
        _setAkismetClientFactoryForTesting((opts) => {
          receivedOpts = opts
          return { verifyKey: async () => true, checkSpam: async () => false }
        })

        await commentsDefaultModule.checkSpam(baseSpamParams(), { akismet: 'my-key' })

        assert.deepEqual(receivedOpts, { key: 'my-key', blog: 'https://test.wiki' })
      })

      it('fails open (not spam) and logs a warning, without throwing, when the key is invalid', async () => {
        _setAkismetClientFactoryForTesting(() => ({
          verifyKey: async () => false,
          checkSpam: async () => {
            throw new Error('should never be called for an invalid key')
          }
        }))

        const result = await commentsDefaultModule.checkSpam(baseSpamParams(), {
          akismet: 'bad-key'
        })

        assert.equal(result.isSpam, false)
        assert.ok(result.reason)
        assert.equal(warnLog.length, 1)
        assert.match(warnLog[0]!, /invalid/i)
      })

      it('fails open and logs a warning, without throwing, when verifyKey rejects (Akismet unreachable)', async () => {
        _setAkismetClientFactoryForTesting(() => ({
          verifyKey: async () => {
            throw new Error('ENOTFOUND rest.akismet.com')
          },
          checkSpam: async () => {
            throw new Error('should never be called')
          }
        }))

        const result = await commentsDefaultModule.checkSpam(baseSpamParams(), {
          akismet: 'some-key'
        })

        assert.equal(result.isSpam, false)
        assert.ok(result.reason)
        assert.equal(warnLog.length, 1)
        assert.match(warnLog[0]!, /ENOTFOUND/)
      })

      it('fails open and logs a warning when checkSpam itself rejects, after a valid key', async () => {
        _setAkismetClientFactoryForTesting(() => ({
          verifyKey: async () => true,
          checkSpam: async () => {
            throw new Error('502 Bad Gateway')
          }
        }))

        const result = await commentsDefaultModule.checkSpam(baseSpamParams(), {
          akismet: 'valid-key'
        })

        assert.equal(result.isSpam, false)
        assert.ok(result.reason)
        assert.equal(warnLog.length, 1)
        assert.match(warnLog[0]!, /502 Bad Gateway/)
      })

      it('validates a given key only once (memoized), reusing the client across calls', async () => {
        const factory = mock.fn(() => ({
          verifyKey: mock.fn(async () => true),
          checkSpam: async () => false
        }))
        _setAkismetClientFactoryForTesting(factory)

        await commentsDefaultModule.checkSpam(baseSpamParams(), { akismet: 'same-key' })
        await commentsDefaultModule.checkSpam(baseSpamParams(), { akismet: 'same-key' })
        await commentsDefaultModule.checkSpam(baseSpamParams(), { akismet: 'same-key' })

        assert.equal(factory.mock.callCount(), 1)
      })

      it('re-validates independently when the key value changes', async () => {
        const factory = mock.fn(() => ({
          verifyKey: async () => true,
          checkSpam: async () => false
        }))
        _setAkismetClientFactoryForTesting(factory)

        await commentsDefaultModule.checkSpam(baseSpamParams(), { akismet: 'key-one' })
        await commentsDefaultModule.checkSpam(baseSpamParams(), { akismet: 'key-two' })

        assert.equal(factory.mock.callCount(), 2)
      })
    })

    it('renders plain text as a paragraph and returns both content and render', async () => {
      const result = await commentsDefaultModule.render('hello world')
      assert.equal(result.content, 'hello world')
      assert.equal(result.render.trim(), '<p>hello world</p>')
    })

    it('syntax-highlights a fenced code block with a known language via highlight.js', async () => {
      const result = await commentsDefaultModule.render('```js\nconst x = 1\n```')
      assert.match(result.render, /<pre><code class="language-js">/)
      // -> highlight.js wraps recognized tokens (`const`, here) in spans with hljs-* classes
      assert.match(result.render, /class="hljs-\w+"/)
      assert.equal(result.content, '```js\nconst x = 1\n```')
    })

    it('falls back to escaped, unhighlighted code for an unknown language', async () => {
      const result = await commentsDefaultModule.render('```notalanguage\n<b>x</b>\n```')
      assert.match(result.render, /<pre><code class="language-notalanguage">/)
      assert.ok(!result.render.includes('<b>x</b>'))
      assert.match(result.render, /&lt;b&gt;x&lt;\/b&gt;/)
    })

    it('renders an emoji shortcode', async () => {
      const result = await commentsDefaultModule.render('nice :smile:')
      assert.ok(!result.render.includes(':smile:'))
      assert.match(result.render, /😄|😃|😊/)
    })

    it('renders a markdown link with linkify off-syntax and autolinks a bare URL (linkify: true)', async () => {
      const result = await commentsDefaultModule.render('[wiki](https://js.wiki)')
      assert.match(result.render, /<a href="https:\/\/js\.wiki">wiki<\/a>/)

      const autolinked = await commentsDefaultModule.render('see https://js.wiki for more')
      assert.match(autolinked.render, /<a href="https:\/\/js\.wiki">https:\/\/js\.wiki<\/a>/)
    })

    it('converts a single newline to <br> (breaks: true)', async () => {
      const result = await commentsDefaultModule.render('line one\nline two')
      assert.match(result.render, /line one<br\s*\/?>\s*line two/)
    })

    it('neuters an attempted <script> injection, storing raw content but never executing markup', async () => {
      const result = await commentsDefaultModule.render('<script>alert(1)</script>')
      assert.ok(!result.render.includes('<script'))
      assert.ok(!/<script[\s>]/i.test(result.render))
    })

    it('neuters an attempted <img onerror> injection', async () => {
      const result = await commentsDefaultModule.render('<img src=x onerror="alert(1)">')
      // -> `html: false` escapes the tag delimiters, so what remains is inert paragraph TEXT — the
      //    literal word "onerror" may still be visible on the page, but there is no real `<img>`
      //    element left for a browser to attach it to as an executing attribute.
      assert.ok(!/<img[\s>]/i.test(result.render))
    })

    it('resolves via fs.access, matching the exact check models/storage.ts runs for storage.ts', async () => {
      // -> models/storage.ts's hasImplementation() runs:
      //      fs.access(path.join(WIKI.SERVERPATH, 'modules/storage', key, 'storage.ts'))
      //    which resolves to <repo-root>/backend/modules/storage/<key>/storage.ts. Once
      //    models/comments.ts exists it is expected to run the same check against
      //    'modules/comments'; this asserts the equivalent path for this module resolves today.
      const serverPath = path.join(import.meta.dirname, '..', '..', '..')
      await assert.doesNotReject(
        fs.access(path.join(serverPath, 'modules/comments', 'default', 'comments.ts'))
      )
    })
  })

  describe('definition.yml', () => {
    it('parses and declares exactly the akismet and minDelay props', async () => {
      const raw = await fs.readFile(path.join(import.meta.dirname, 'definition.yml'), 'utf8')
      const parsed = load(raw) as Record<string, any>

      assert.equal(parsed.key, 'default')
      assert.equal(parsed.isAvailable, true)
      assert.equal(typeof parsed.title, 'string')
      assert.ok(parsed.title.length > 0)
      assert.equal(typeof parsed.description, 'string')
      assert.ok(parsed.description.length > 0)
      assert.equal(parsed.vendor, 'Wiki.js')
      assert.equal(parsed.website, 'https://js.wiki')

      const props = parseModuleProps(parsed.props ?? {})
      assert.deepEqual(Object.keys(props).sort(), ['akismet', 'minDelay'])

      assert.equal(props.akismet.type, 'string')
      assert.equal(props.akismet.sensitive, true)
      assert.equal(props.akismet.default, '')
      assert.equal(props.akismet.order, 1)

      assert.equal(props.minDelay.type, 'number')
      assert.equal(props.minDelay.default, 30)
      assert.equal(props.minDelay.order, 2)
    })

    it('has a comments.ts sibling, so hasImplementation() would report true', async () => {
      await assert.doesNotReject(fs.access(path.join(import.meta.dirname, 'comments.ts')))
    })
  })
})
