import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { LOG_SCOPES, type LogScope } from './logScopes.ts'
import { LOG_SCOPES as reexported } from './logger.ts'

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
    // -> The sentinel of the retired `(msg, context?)` call shape. It must not come back as a real
    //    scope: a line filed under `legacy` says nothing about which subsystem produced it.
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

    // -> `tsc` fails this file if the assignment below ever STOPS being an error, so a widening of
    //    `LogScope` to `string` breaks the build here rather than silently at every call site.
    // @ts-expect-error — 'nope' is not a member of LOG_SCOPES.
    const bad: LogScope = 'nope'
    assert.equal(bad, 'nope')

    // @ts-expect-error — `legacy` was the retired renderer sentinel; it is not a scope either.
    const sentinel: LogScope = 'legacy'
    assert.equal(sentinel, 'legacy')
  })

  test('the array itself is readonly at the type level', () => {
    // -> By assignment rather than by calling `push`, which `as const` does not prevent at runtime.
    // @ts-expect-error — `as const` makes LOG_SCOPES a readonly tuple, not a mutable string[].
    const mutable: string[] = LOG_SCOPES
    assert.equal(mutable.length, LOG_SCOPES.length)
  })
})
