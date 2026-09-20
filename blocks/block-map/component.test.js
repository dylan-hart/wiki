import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import './component.js'
import { resolveTileSettings } from './component.js'
import { _resetSiteCache } from '../shared/site.js'
import { describeDarkMode } from '../test/darkMode.js'
import { mountBlock, resetBlockDom, stubSiteFetch } from '../test/mount.js'

const OSM_DEFAULT = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'

/**
 * `settle: 2` — `firstUpdated` awaits `getBlockConfig` before building the tile layer, so its body
 * runs after `updateComplete` has already resolved.
 */
const mountMap = (props = {}) =>
  mountBlock('block-map', { props: { lat: 45.5019, lon: -73.5674, ...props }, settle: 2 })

function tileImgSrc(el) {
  return el.shadowRoot.querySelector('.leaflet-tile-container img')?.getAttribute('src') ?? ''
}

const stubSiteConfig = (blocksConfig = {}) => stubSiteFetch({ site: { blocksConfig } })

describe('block-map tile server precedence', () => {
  beforeEach(() => {
    // -> getBlockConfig caches its fetch for the module's lifetime, so a test's own site-config
    //    response would otherwise be ignored in favour of the previous test's
    _resetSiteCache()
  })

  afterEach(() => {
    resetBlockDom()
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
      const fetchMock = stubSiteConfig({})
      await mountMap()
      expect(fetchMock).toHaveBeenCalledWith('/_api/sites/current')
    })
  })

  /*
   * `{ attribute: false }`: this block's controller sets no `dark` attribute, since the `theme`
   * prop can pin a map light on a dark page, so the assertion is on the controller's own `isDark`.
   */
  describeDarkMode(
    () => {
      stubSiteConfig({})
      return mountMap()
    },
    { attribute: false }
  )
})
