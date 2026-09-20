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

describe('shared/config.js: getBlockImportUrl()', () => {
  beforeEach(() => {
    // -> Both exports share one site fetch cached for the module's lifetime; each test needs its
    //    own site-info response, so the cache must not survive between them.
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
