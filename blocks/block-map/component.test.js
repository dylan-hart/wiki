import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import './component.js'
import { resolveTileSettings } from './component.js'
import { _resetBlockConfigCache } from '../shared/config.js'

const OSM_DEFAULT = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'

/**
 * Mounts a `<block-map>` with valid coordinates, optionally carrying page-authored props, and waits
 * past `firstUpdated`'s `getBlockConfig` fetch and Leaflet's own tile-layer setup.
 */
async function mountMap(props = {}) {
  const el = document.createElement('block-map')
  el.lat = 45.5019
  el.lon = -73.5674
  Object.assign(el, props)
  document.body.appendChild(el)
  await el.updateComplete
  // -> firstUpdated is async (it awaits getBlockConfig before building the tile layer), so its own
  //    body runs after updateComplete resolves. A couple of microtask turns is enough for the
  //    stubbed fetch's promise chain and the synchronous Leaflet setup after it to settle.
  await new Promise((resolve) => setTimeout(resolve, 0))
  await new Promise((resolve) => setTimeout(resolve, 0))
  return el
}

/** The `src` Leaflet actually gave the one tile it drew for this map, or '' if none was found. */
function tileImgSrc(el) {
  return el.shadowRoot.querySelector('.leaflet-tile-container img')?.getAttribute('src') ?? ''
}

function stubSiteConfig(blocksConfig = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ blocksConfig })
    })
  )
}

describe('block-map tile server precedence', () => {
  beforeEach(() => {
    // -> getBlockConfig caches its fetch for the module's lifetime (one request per real page load);
    //    each test needs its own site-config response, so the cache must not survive between them.
    _resetBlockConfigCache()
  })

  afterEach(() => {
    document.body.replaceChildren()
    vi.unstubAllGlobals()
  })

  describe('resolveTileSettings', () => {
    it('falls back to the hardcoded OSM default when neither site config nor a prop set anything', () => {
      expect(resolveTileSettings({}, {})).toEqual({ tileServerUrl: OSM_DEFAULT, apiKey: '' })
    })

    it('uses the page-authored prop over the default when there is no site config', () => {
      expect(
        resolveTileSettings(
          {},
          { tileServerUrl: 'https://prop.example/{z}/{x}/{y}.png', apiKey: 'prop-key' }
        )
      ).toEqual({ tileServerUrl: 'https://prop.example/{z}/{x}/{y}.png', apiKey: 'prop-key' })
    })

    it('uses the site config over both the prop and the default', () => {
      expect(
        resolveTileSettings(
          { tileServerUrl: 'https://site.example/{z}/{x}/{y}.png', apiKey: 'site-key' },
          { tileServerUrl: 'https://prop.example/{z}/{x}/{y}.png', apiKey: 'prop-key' }
        )
      ).toEqual({ tileServerUrl: 'https://site.example/{z}/{x}/{y}.png', apiKey: 'site-key' })
    })
  })

  // -> The acceptance bar for this task is the whole chain end-to-end, not just resolveTileSettings
  //    in isolation: fetch -> getBlockConfig -> firstUpdated -> the tile actually drawn by Leaflet.
  describe('end-to-end, as actually drawn by Leaflet', () => {
    it('draws the built-in OSM tiles when nothing overrides them', async () => {
      stubSiteConfig({})
      const el = await mountMap()
      expect(tileImgSrc(el)).toContain('tile.openstreetmap.org')
    })

    it('draws from the page-authored tileServerUrl prop when the site has no config for this block', async () => {
      stubSiteConfig({})
      const el = await mountMap({ tileServerUrl: 'https://prop-tiles.example/{z}/{x}/{y}.png' })
      expect(tileImgSrc(el)).toContain('prop-tiles.example')
    })

    it("draws from the site's block config even when the page also sets its own prop", async () => {
      stubSiteConfig({ map: { tileServerUrl: 'https://site-tiles.example/{z}/{x}/{y}.png' } })
      const el = await mountMap({ tileServerUrl: 'https://prop-tiles.example/{z}/{x}/{y}.png' })
      expect(tileImgSrc(el)).toContain('site-tiles.example')
      expect(tileImgSrc(el)).not.toContain('prop-tiles.example')
    })

    it('fetches the site config from the public, ungated site-info endpoint', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue({ ok: true, json: async () => ({ blocksConfig: {} }) })
      vi.stubGlobal('fetch', fetchMock)
      await mountMap()
      expect(fetchMock).toHaveBeenCalledWith('/_api/sites/current')
    })
  })
})
