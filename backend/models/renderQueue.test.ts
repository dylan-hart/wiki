import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { renderQueue } from './renderQueue.ts'
import { installTestWiki } from '../test/mocks.ts'

/*
 * `resolveSiteOrigin` is what carries the site's real hostname into the headless renderer's context
 * (OpenProject #1751), so `isExternalHref` in `frontend/src/renderers/markdown.js` classifies an
 * absolute same-site link the same way whether it was just saved by the editor or re-rendered
 * headlessly afterwards. Mirrors `models/mail.ts`'s `resolveMailBaseURL` -- same `https://<hostname>`
 * assumption, same `*`-catch-all/unresolvable-siteId fallback.
 *
 * Private, hence the cast. Nothing here opens a browser or reaches the database: the rest of this
 * model is a Puppeteer drain loop, which is exercised end to end by the e2e suite rather than here.
 */
const wiki = installTestWiki()
after(() => wiki.restore())

describe('renderQueue.resolveSiteOrigin (OpenProject #1751)', () => {
  test('builds https://<hostname> for a real site', () => {
    WIKI.sites = { site1: { hostname: 'wiki.example.com' } } as any

    assert.equal((renderQueue as any).resolveSiteOrigin('site1'), 'https://wiki.example.com')
  })

  test('returns undefined for the "*" catch-all site, which has no hostname of its own', () => {
    WIKI.sites = { site1: { hostname: '*' } } as any

    assert.equal((renderQueue as any).resolveSiteOrigin('site1'), undefined)
  })

  test('returns undefined for a siteId with no cached site', () => {
    WIKI.sites = {} as any

    assert.equal((renderQueue as any).resolveSiteOrigin('missing'), undefined)
  })
})
