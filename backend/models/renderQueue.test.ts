import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { renderQueue } from './renderQueue.ts'
import { installTestWiki } from '../test/mocks.ts'

/*
 * `resolveSiteOrigin` is private, hence the cast. Nothing here opens a browser or reaches the
 * database: the rest of this model is a Puppeteer drain loop, exercised end to end by the e2e suite.
 */
const wiki = installTestWiki()
after(() => wiki.restore())

describe('renderQueue.resolveSiteOrigin (OpenProject #1751)', () => {
  test('builds https://<hostname> for a real site', () => {
    CARDINAL.sites = { site1: { hostname: 'wiki.example.com' } } as any

    assert.equal((renderQueue as any).resolveSiteOrigin('site1'), 'https://wiki.example.com')
  })

  test('returns undefined for the "*" catch-all site, which has no hostname of its own', () => {
    CARDINAL.sites = { site1: { hostname: '*' } } as any

    assert.equal((renderQueue as any).resolveSiteOrigin('site1'), undefined)
  })

  test('returns undefined for a siteId with no cached site', () => {
    CARDINAL.sites = {} as any

    assert.equal((renderQueue as any).resolveSiteOrigin('missing'), undefined)
  })
})

/**
 * The gate is keyed off `getContentTypeForEditor()` rather than the editor name, so any editor whose
 * OUTPUT is markdown clears it, `wysiwyg` included. A gate that passes still needs Puppeteer, so
 * these assert on the error NAME to tell "refused for being an unsupported editor"
 * (`renderUnsupportedEditor`) apart from "would be fine, but nothing here can render it"
 * (`renderPuppeteerMissing`); `getDefinition: () => undefined` stands in for an uninstalled
 * extension without needing the whole extensions model.
 */
describe('renderQueue.ensureCanRender (OpenProject #3401)', () => {
  test('a markdown-editor page clears the editor gate and only fails on missing Puppeteer', async () => {
    const scoped = installTestWiki({ models: { extensions: { getDefinition: () => undefined } } })
    try {
      await assert.rejects(renderQueue.ensureCanRender('markdown'), (err: any) => {
        assert.equal(err.name, 'renderPuppeteerMissing')
        return true
      })
    } finally {
      scoped.restore()
    }
  })

  test('a wysiwyg-editor page no longer refuses as an unsupported editor -- its content is markdown now', async () => {
    const scoped = installTestWiki({ models: { extensions: { getDefinition: () => undefined } } })
    try {
      await assert.rejects(renderQueue.ensureCanRender('wysiwyg'), (err: any) => {
        assert.equal(err.name, 'renderPuppeteerMissing')
        return true
      })
    } finally {
      scoped.restore()
    }
  })

  test('a code-editor page (content type html) still refuses as an unsupported editor', async () => {
    await assert.rejects(renderQueue.ensureCanRender('code'), (err: any) => {
      assert.equal(err.name, 'renderUnsupportedEditor')
      assert.match(err.message, /code/)
      return true
    })
  })

  test('asciidoc and redirect pages still refuse as an unsupported editor', async () => {
    await assert.rejects(renderQueue.ensureCanRender('asciidoc'), (err: any) => {
      assert.equal(err.name, 'renderUnsupportedEditor')
      return true
    })
    await assert.rejects(renderQueue.ensureCanRender('redirect'), (err: any) => {
      assert.equal(err.name, 'renderUnsupportedEditor')
      return true
    })
  })
})
