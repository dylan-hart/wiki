import assert from 'node:assert/strict'
import { after, beforeEach, describe, mock, test } from 'node:test'
import { FLAGS, flags } from './flags.ts'
import { installTestWiki } from '../test/mocks.ts'

/**
 * Pure unit tests: every method here reads `WIKI.config.flags` and writes through `WIKI.logger`, so
 * a minimal stand-in global is enough — no database, and `updateFlags`'s one persistence hop is a
 * stubbed `WIKI.configSvc`.
 */
describe('flags model', () => {
  let wikiHandle: { restore(): void }
  let debugCalls: { scope: string; message: string }[]
  let infoCalls: { scope: string; message: string; fields?: Record<string, unknown> }[]

  after(() => {
    wikiHandle.restore()
  })

  beforeEach(() => {
    debugCalls = []
    infoCalls = []
    wikiHandle = installTestWiki({
      config: { flags: { experimental: false, authDebug: false, sqlLog: false } },
      configSvc: { saveToDb: mock.fn(async () => true) },
      logger: {
        error: () => {},
        warn: () => {},
        info: (scope: string, message: string, fields?: Record<string, unknown>) => {
          infoCalls.push({ scope, message, fields })
        },
        debug: (scope: string, message: string) => {
          debugCalls.push({ scope, message })
        }
      }
    })
  })

  describe('getFlags() / isEnabled()', () => {
    test('a flag missing from the stored blob reads as off, not undefined', () => {
      WIKI.config.flags = { experimental: true }

      assert.deepEqual(flags.getFlags(), {
        experimental: true,
        authDebug: false,
        sqlLog: false
      })
      assert.equal(flags.isEnabled('sqlLog'), false)
    })

    test('only a literal true counts as on', () => {
      WIKI.config.flags = { sqlLog: 'true', authDebug: 1 }

      assert.equal(flags.isEnabled('sqlLog'), false)
      assert.equal(flags.isEnabled('authDebug'), false)
    })
  })

  /**
   * OpenProject #2663: the two debug flags are no longer switches of their own — each is a runtime
   * override of one log scope's threshold, which `core/logger.ts` resolves ahead of `logScopes:` and
   * `logLevel` on every single line.
   */
  describe('logScopeOverrides()', () => {
    test('both flags off: no scope has an override at all', () => {
      // -> An empty map, not `{ sql: 'info' }`: absence is what lets `logScopes:` and then
      //    `logLevel` answer for the scope instead.
      assert.deepEqual(flags.logScopeOverrides(), {})
    })

    test('sqlLog on raises the sql scope to debug, and nothing else', () => {
      WIKI.config.flags.sqlLog = true

      assert.deepEqual(flags.logScopeOverrides(), { sql: 'debug' })
    })

    test('authDebug on raises the auth scope to debug, and nothing else', () => {
      WIKI.config.flags.authDebug = true

      assert.deepEqual(flags.logScopeOverrides(), { auth: 'debug' })
    })

    test('both on raises both', () => {
      WIKI.config.flags.sqlLog = true
      WIKI.config.flags.authDebug = true

      assert.deepEqual(flags.logScopeOverrides(), { sql: 'debug', auth: 'debug' })
    })

    test('the map is re-derived per call, so flipping a flag needs no restart', () => {
      assert.deepEqual(flags.logScopeOverrides(), {})

      WIKI.config.flags.sqlLog = true
      assert.deepEqual(flags.logScopeOverrides(), { sql: 'debug' })

      WIKI.config.flags.sqlLog = false
      assert.deepEqual(flags.logScopeOverrides(), {})
    })

    test('the experimental flag is not a log scope override', () => {
      WIKI.config.flags.experimental = true

      assert.deepEqual(flags.logScopeOverrides(), {})
    })
  })

  /**
   * `authDebug()` used to gate itself on the flag and emit at `info` so the line would clear the
   * default floor. Both halves of that are gone: the flag raises the scope, and the level is the
   * honest one for a per-attempt line.
   */
  describe('authDebug()', () => {
    test('emits a debug auth line with the flag off, and lets the threshold drop it', () => {
      flags.authDebug('local login attempt for user 42')

      assert.deepEqual(debugCalls, [{ scope: 'auth', message: 'local login attempt for user 42' }])
    })

    test('emits the same line with the flag on — the flag is not a gate here', () => {
      WIKI.config.flags.authDebug = true

      flags.authDebug('local login attempt for user 42')

      assert.deepEqual(debugCalls, [{ scope: 'auth', message: 'local login attempt for user 42' }])
    })

    test('never emits at info, whatever the flag says', () => {
      WIKI.config.flags.authDebug = true

      flags.authDebug('a detail')

      assert.deepEqual(infoCalls, [])
    })
  })

  describe('pickFlags() / updateFlags()', () => {
    test('pickFlags keeps only the flags this model owns', () => {
      assert.deepEqual(flags.pickFlags({ sqlLog: true, notAFlag: true, experimental: false }), {
        sqlLog: true,
        experimental: false
      })
    })

    test('a saved patch logs one config line per changed flag and leaves the rest alone', async () => {
      assert.equal(await flags.updateFlags({ sqlLog: true }), true)

      assert.deepEqual(WIKI.config.flags, {
        experimental: false,
        authDebug: false,
        sqlLog: true
      })
      assert.deepEqual(infoCalls, [
        {
          scope: 'config',
          message: 'system flag changed',
          fields: { key: 'sqlLog', enabled: true }
        }
      ])
    })

    test('a failed save rolls the flags back and reports it, logging nothing', async () => {
      WIKI.configSvc.saveToDb = mock.fn(async () => false)

      assert.equal(await flags.updateFlags({ sqlLog: true }), false)

      assert.equal(flags.isEnabled('sqlLog'), false)
      assert.deepEqual(infoCalls, [])
    })
  })

  /**
   * The descriptions are what an administrator reads next to the switch, and both switches now do
   * something different from what they used to. A description still promising "queries are logged"
   * with no mention of the scope it raises would describe a switch that no longer exists.
   */
  describe('FLAGS descriptions', () => {
    test('each flag in the union has a description', () => {
      for (const [key, description] of Object.entries(FLAGS)) {
        assert.equal(typeof description, 'string', `${key} needs a description`)
        assert.ok(description.length > 0, `${key} needs a description`)
      }
    })

    test('the two log flags say which scope they raise', () => {
      assert.match(FLAGS.sqlLog, /`sql` log scope/)
      assert.match(FLAGS.authDebug, /`auth` log scope/)
    })

    test('sqlLog still warns that a bound parameter can carry a credential', () => {
      // -> OpenProject #2205's warning must survive the reword: the values are redacted, but an
      //    administrator turning this on should know what class of data the line is near.
      assert.match(FLAGS.sqlLog, /never its value/)
      assert.match(FLAGS.sqlLog, /credential/i)
    })
  })
})
