import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { load } from 'js-yaml'
import { parseCspDirectives } from '../helpers/security.ts'
import { securityCspSeed } from './settings.ts'

/**
 * Unit tests for WP #2158/#2166 (part of #2154): `securityCspSeed` is what a fresh instance's
 * `security` settings row actually seeds `cspDirectives`/`enforceCsp` from -- unlike every other
 * field `Settings#init` seeds, which is a hardcoded literal, these two are read from
 * `WIKI.config.security` (`base.yml` merged with any `config.yml` override) specifically so
 * `e2e/config.e2e.yml` can turn `enforceCsp` on for `e2e/tests/csp.spec.js` without touching what a
 * real fresh install ships with. Pure function, no `WIKI` global and no database, per this
 * workspace's testing convention.
 */
describe('securityCspSeed', () => {
  test('reads both fields straight through when config sets them', () => {
    assert.deepEqual(
      securityCspSeed(
        { security: { cspDirectives: "default-src 'self'", enforceCsp: true } },
        undefined
      ),
      { cspDirectives: "default-src 'self'", enforceCsp: true }
    )
  })

  test('enforceCsp defaults to false when config leaves it unset', () => {
    assert.equal(
      securityCspSeed({ security: { cspDirectives: "default-src 'self'" } }, undefined).enforceCsp,
      false
    )
  })

  test("falls back to data's parsed base.yml default when config sets neither", () => {
    const result = securityCspSeed(undefined, {
      defaults: { config: { security: { cspDirectives: "object-src 'none'" } } }
    })
    assert.deepEqual(result, { cspDirectives: "object-src 'none'", enforceCsp: false })
  })

  test('falls back to an empty string when nothing anywhere sets cspDirectives', () => {
    assert.equal(securityCspSeed(undefined, undefined).cspDirectives, '')
  })

  test('config.security.cspDirectives wins over the data fallback when both are set', () => {
    const result = securityCspSeed(
      { security: { cspDirectives: "default-src 'self'" } },
      { defaults: { config: { security: { cspDirectives: "object-src 'none'" } } } }
    )
    assert.equal(result.cspDirectives, "default-src 'self'")
  })

  test('in real boot order (config.init() before initDbValues()), the shipped backend/base.yml default flows through untouched', () => {
    const config: any = load(readFileSync(path.join(import.meta.dirname, '../base.yml'), 'utf8'))
    // -> `configSvc.init()` merges `config.yml` onto `appdata.defaults.config` -- with no override,
    //    `WIKI.config.security` ends up identical to `base.yml`'s own `defaults.config.security`.
    const result = securityCspSeed(
      { security: config.defaults.config.security },
      { defaults: { config: { security: config.defaults.config.security } } }
    )
    assert.equal(result.cspDirectives, config.defaults.config.security.cspDirectives)
    assert.equal(result.enforceCsp, false)
    assert.doesNotThrow(() => parseCspDirectives(result.cspDirectives))
  })
})
