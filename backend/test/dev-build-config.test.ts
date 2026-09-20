import { describe, mock, test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'
import cfgHelper from '../helpers/config.ts'
import logger from '../core/logger.ts'
import { installTestWiki } from './mocks.ts'

/**
 * Guards the published image starting with no env overrides at all: a template default the
 * validator rejects is an `exit(1)` at boot. Drives the real substitution and the real
 * `assertValidLogConfig` rather than restating either — a copy would only re-assert today's rules.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.join(HERE, '..', '..')
const TEMPLATE_PATH = path.join(REPO_ROOT, 'dev', 'build', 'config.yml')

/** Must NOT be set in the test environment, or substitution resolves to the override instead of
 *  the template default this test exists to check. */
const TEMPLATE_ENV_VARS = [
  'LOG_LEVEL',
  'LOG_FORMAT',
  'WIKI_OFFLINE',
  'DB_PORT',
  'DB_SCHEMA',
  'DB_SSL'
]

describe('dev/build/config.yml (#2727)', () => {
  afterEach(() => {
    mock.restoreAll()
  })

  test('resolves logLevel/logFormat/logScopes defaults that assertValidLogConfig accepts', async () => {
    for (const name of TEMPLATE_ENV_VARS) {
      assert.equal(
        process.env[name],
        undefined,
        `expected ${name} to be unset in the test environment so the template's own default is what gets checked`
      )
    }

    const raw = await readFile(TEMPLATE_PATH, 'utf8')
    const resolved = cfgHelper.parseConfigValue(raw)
    const parsed = load(resolved) as {
      logLevel?: unknown
      logFormat?: unknown
      logScopes?: unknown
    }

    // -> Every referenced var must carry a `:default`, or an unset one resolves to an empty string.
    assert.ok(
      !resolved.includes('$('),
      `expected every $(VAR) in the template to carry a :default; got unresolved: ${resolved}`
    )

    installTestWiki({
      config: {
        logLevel: parsed.logLevel,
        logFormat: parsed.logFormat,
        logScopes: parsed.logScopes
      },
      INSTANCE_ID: 'test-instance'
    })
    const errorSpy = mock.method(console, 'error', () => {})
    const exit = mock.fn()

    logger.init({ exit })

    assert.equal(
      exit.mock.calls.length,
      0,
      `expected the template's resolved log config to pass assertValidLogConfig; got logLevel=${JSON.stringify(parsed.logLevel)} logFormat=${JSON.stringify(parsed.logFormat)} logScopes=${JSON.stringify(parsed.logScopes)}, errors: ${errorSpy.mock.calls.map((c) => c.arguments[0]).join(' | ')}`
    )
    assert.equal(errorSpy.mock.calls.length, 0)
  })
})
