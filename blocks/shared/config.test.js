import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getBlockConfig, getBlockImportUrl } from './config.js'
import { _resetSiteCache } from './site.js'

function stubSite(site) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => site
    })
  )
}

/*
 * OpenProject #954: `getBlockImportUrl` is `blocks/`'s own equivalent of `blockImportUrl()` in
 * `frontend/src/stores/common.js` -- it resolves a block's compiled-code URL off the public
 * `/_api/sites/current` response's `blocksIndex` map rather than the manage:sites-gated
 * `GET /sites/:siteId/blocks` route, which a plain reader is refused. `block-include`'s
 * `_loadNestedBlocks` is the first caller: a custom block nested inside transcluded content has no
 * other way to resolve its import URL for itself.
 */
describe('shared/config.js: getBlockImportUrl()', () => {
  beforeEach(() => {
    // -> Both exports share one cached fetch for the module's lifetime (one request per real page
    //    load); each test needs its own site-info response, so the cache must not survive between
    //    them -- the same reason block-map's own tests reset it.
    _resetSiteCache()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('addresses a built-in block by its flat, site-independent compiled-output URL', async () => {
    stubSite({ id: 'site-1', blocksIndex: { alert: { id: 'builtin-alert-id', isCustom: false } } })

    expect(await getBlockImportUrl('block-alert')).toBe('/_blocks/block-alert.js')
  })

  it('addresses a custom block by site and id, under /_blocks/custom/', async () => {
    stubSite({ id: 'site-1', blocksIndex: { widget: { id: 'block-9', isCustom: true } } })

    expect(await getBlockImportUrl('block-widget')).toBe('/_blocks/custom/site-1/block-9.js')
  })

  it('falls back to the flat URL for a tag blocksIndex has no entry for', async () => {
    stubSite({ id: 'site-1', blocksIndex: {} })

    expect(await getBlockImportUrl('block-unregistered')).toBe('/_blocks/block-unregistered.js')
  })

  it('falls back to the flat URL when the site-info fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))

    expect(await getBlockImportUrl('block-widget')).toBe('/_blocks/block-widget.js')
  })
})

describe('shared/config.js: getBlockConfig() reads off the same cached fetch', () => {
  beforeEach(() => {
    _resetSiteCache()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns the config for the requested tag', async () => {
    stubSite({ id: 'site-1', blocksConfig: { map: { tileServerUrl: 'https://example.test' } } })

    expect(await getBlockConfig('map')).toEqual({ tileServerUrl: 'https://example.test' })
  })

  it('returns an empty object for a tag with nothing configured', async () => {
    stubSite({ id: 'site-1', blocksConfig: {} })

    expect(await getBlockConfig('map')).toEqual({})
  })
})
