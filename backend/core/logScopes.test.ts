import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { LOG_SCOPES, type LogScope } from './logScopes.ts'
import { LOG_SCOPES as reexported } from './logger.ts'

/**
 * Pure unit test: the vocabulary is a plain array, so nothing here needs a `WIKI` global, a database
 * or the logger's renderer.
 */
describe('LOG_SCOPES', () => {
  test('is exactly the 27 names of the recommendations §2.3 table, in its order', () => {
    assert.deepEqual(
      [...LOG_SCOPES],
      [
        'boot',
        'config',
        'db',
        'sql',
        'http',
        'auth',
        'session',
        'jobs',
        'worker',
        'mail',
        'storage',
        'search',
        'render',
        'collab',
        'cluster',
        'locale',
        'icons',
        'blocks',
        'ext',
        'pages',
        'assets',
        'nav',
        'hooks',
        'mcp',
        'terminal',
        'migrate',
        'audit'
      ]
    )
  })

  test('holds no duplicate name', () => {
    assert.equal(new Set(LOG_SCOPES).size, LOG_SCOPES.length)
  })

  test('does not contain `legacy`', () => {
    // -> `legacy` was the renderer's sentinel for a call still using the pre-scope shape, so the
    //    Phase 2 sweep could grep for what was left. Both the sentinel and the overload behind it
    //    went with OpenProject #2668, and the name must not come back as a real scope on the way
    //    past: a line filed under `legacy` says nothing about which subsystem produced it, which is
    //    the one thing a scope is for.
    assert.equal((LOG_SCOPES as readonly string[]).includes('legacy'), false)
  })

  test('`core/logger.ts` re-exports the same array, not a second copy', () => {
    assert.equal(reexported, LOG_SCOPES)
  })

  test('every name is a lowercase, single-word identifier', () => {
    for (const scope of LOG_SCOPES) {
      assert.match(scope, /^[a-z]+$/, `${scope} is not a bare lowercase word`)
    }
  })
})

describe('LogScope (type level)', () => {
  test('accepts a member of the vocabulary and refuses anything else', () => {
    const good: LogScope = 'storage'
    assert.equal(good, 'storage')

    // -> The closed half of the vocabulary, and the reason the array is `as const`. `tsc` fails this
    //    file if the assignment below ever STOPS being an error, so a widening of `LogScope` to
    //    `string` breaks the build here rather than silently at every call site.
    // @ts-expect-error — 'nope' is not a member of LOG_SCOPES.
    const bad: LogScope = 'nope'
    assert.equal(bad, 'nope')

    // @ts-expect-error — `legacy` was the retired renderer sentinel; it is not a scope either.
    const sentinel: LogScope = 'legacy'
    assert.equal(sentinel, 'legacy')
  })

  test('the array itself is readonly at the type level', () => {
    // -> Asserted by assignment rather than by calling `push`, which `as const` does not actually
    //    prevent at runtime — the point is that no caller can widen the vocabulary through the array.
    // @ts-expect-error — `as const` makes LOG_SCOPES a readonly tuple, not a mutable string[].
    const mutable: string[] = LOG_SCOPES
    assert.equal(mutable.length, LOG_SCOPES.length)
  })
})
