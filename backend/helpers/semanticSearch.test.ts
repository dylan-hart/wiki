import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import { installTestWiki } from '../test/mocks.ts'
import { semanticSearchAvailable, semanticSearchEnabledFor } from './semanticSearch.ts'

const SITE = '11111111-1111-4111-8111-111111111111'

const siteConfig = (semanticEnabled: unknown) => ({ search: { config: { semanticEnabled } } })

let installed: { restore(): void } | undefined

afterEach(() => {
  installed?.restore()
  installed = undefined
})

function stubCardinal(capability: unknown, sites: Record<string, unknown> = {}) {
  installed?.restore()
  installed = installTestWiki({
    ...(capability === undefined ? {} : { capabilities: { semanticSearch: capability } }),
    sites
  })
}

describe('semanticSearchAvailable', () => {
  test('true only when the capability flag and the site toggle are both true', () => {
    stubCardinal(true)
    assert.equal(semanticSearchAvailable(siteConfig(true)), true)
  })

  test('false when the site toggle is off, even with the capability present', () => {
    stubCardinal(true)
    assert.equal(semanticSearchAvailable(siteConfig(false)), false)
  })

  test('false when the capability is absent, even with the site toggle on', () => {
    stubCardinal(false)
    assert.equal(semanticSearchAvailable(siteConfig(true)), false)
  })

  test('false on a CARDINAL with no capabilities at all (a test stub)', () => {
    stubCardinal(undefined)
    assert.equal(semanticSearchAvailable(siteConfig(true)), false)
  })

  test('false for a config with no search block, or no config', () => {
    stubCardinal(true)
    assert.equal(semanticSearchAvailable({}), false)
    assert.equal(semanticSearchAvailable({ search: {} }), false)
    assert.equal(semanticSearchAvailable(undefined), false)
    assert.equal(semanticSearchAvailable(null), false)
  })

  test('truthy values other than true do not count', () => {
    for (const value of ['true', 1, {}, []]) {
      stubCardinal(true)
      assert.equal(
        semanticSearchAvailable(siteConfig(value)),
        false,
        `site toggle ${String(value)}`
      )
      stubCardinal(value)
      assert.equal(semanticSearchAvailable(siteConfig(true)), false, `capability ${String(value)}`)
    }
  })
})

describe('semanticSearchEnabledFor', () => {
  test('resolves the site config from CARDINAL.sites', () => {
    stubCardinal(true, { [SITE]: { config: siteConfig(true) } })
    assert.equal(semanticSearchEnabledFor(SITE), true)
  })

  test('false for an unknown site or one without a config', () => {
    stubCardinal(true, { [SITE]: {} })
    assert.equal(semanticSearchEnabledFor(SITE), false)
    assert.equal(semanticSearchEnabledFor('unknown'), false)
  })

  test('a truthy non-true site toggle no longer enables it', () => {
    stubCardinal(true, { [SITE]: { config: siteConfig('yes') } })
    assert.equal(semanticSearchEnabledFor(SITE), false)
  })
})
