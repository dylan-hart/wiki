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
 * Guards work package #2727 — the production Docker image's config template
 * (`dev/build/config.yml`) once baked `logFormat: $(LOG_FORMAT:default)`, so an unset
 * `LOG_FORMAT` resolved to the literal string `default`. `core/logger.ts`'s boot-time
 * `assertValidLogConfig` only accepts `text`/`json` and `exit(1)`s on anything else, so the
 * published image refused to start out of the box unless an operator happened to set
 * `LOG_FORMAT` explicitly.
 *
 * This reads the real template, applies the same `$(VAR:default)` substitution
 * `core/config.ts` applies at real boot (`helpers/config.ts#parseConfigValue`, with no env
 * vars overridden — the "container shipped with no overrides" case an operator following the
 * documented quick-start actually hits), parses the result as YAML, and runs it through the
 * real `assertValidLogConfig` (via `logger.init({ exit })`, the same seam `core/logger.test.ts`
 * uses) rather than re-describing either the substitution rule or the validator's accepted
 * values by hand — a copy of either would only re-assert this bug's own assumptions instead of
 * catching a future regression in the template.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.join(HERE, '..', '..')
const TEMPLATE_PATH = path.join(REPO_ROOT, 'dev', 'build', 'config.yml')

/** The `$(VAR:default)` names the template references — must NOT be set in the environment a
 *  test runs in, or the substitution would resolve to the override instead of the default this
 *  test exists to check. */
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

    // -> No leftover `$(...)` placeholder: every referenced var in the template must carry a
    //    `:default`, or an unset env var would resolve to an empty string instead.
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
