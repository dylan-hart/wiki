import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  defaultPageSource,
  escapeHtml,
  HL_START,
  HL_STOP,
  normalizeMarkers,
  REBUILD_BATCH_SIZE
} from './shared.ts'

describe('escapeHtml()', () => {
  test('escapes the four characters that could turn page text into markup', () => {
    assert.equal(escapeHtml(`<script>a & b "c"`), '&lt;script&gt;a &amp; b &quot;c&quot;')
  })

  test('escapes the ampersand first, so an escape sequence is never double-escaped away', () => {
    assert.equal(escapeHtml('&lt;'), '&amp;lt;')
  })

  test('leaves text with nothing to escape untouched', () => {
    assert.equal(escapeHtml('plain text'), 'plain text')
  })

  test('leaves a single quote alone — it is not one of the four', () => {
    assert.equal(escapeHtml("it's"), "it's")
  })
})

describe('normalizeMarkers()', () => {
  test('the markers are the C0 control characters, not anything that could occur in page text', () => {
    assert.equal(HL_START, '\u0002')
    assert.equal(HL_STOP, '\u0003')
  })

  test('turns the control-character markers into <b> tags', () => {
    assert.equal(normalizeMarkers(`a ${HL_START}match${HL_STOP} here`), 'a <b>match</b> here')
  })

  test('escapes the fragment before the markers become tags, so page markup cannot survive', () => {
    assert.equal(normalizeMarkers(`${HL_START}<script>${HL_STOP}`), '<b>&lt;script&gt;</b>')
  })

  test('normalizes every marker in the fragment, not just the first', () => {
    assert.equal(
      normalizeMarkers(`${HL_START}a${HL_STOP} and ${HL_START}b${HL_STOP}`),
      '<b>a</b> and <b>b</b>'
    )
  })

  test('an absent or empty fragment is null, not an empty string', () => {
    assert.equal(normalizeMarkers(undefined), null)
    assert.equal(normalizeMarkers(null), null)
    assert.equal(normalizeMarkers(''), null)
  })
})

describe('defaultPageSource()', () => {
  let previousDb: any

  before(() => {
    ;(globalThis as any).WIKI = (globalThis as any).WIKI ?? {}
    previousDb = (globalThis as any).WIKI.db
  })

  after(() => {
    ;(globalThis as any).WIKI.db = previousDb
  })

  test('locales() reads the distinct locales of one site, in the order postgres returned them', async () => {
    const calls: any[] = []
    ;(globalThis as any).WIKI.db = {
      selectDistinct: (columns: any) => {
        calls.push(columns)
        return {
          from: () => ({
            where: () => ({
              orderBy: async () => [{ locale: 'en' }, { locale: 'fr' }]
            })
          })
        }
      }
    }

    assert.deepEqual(await defaultPageSource().locales('site-1'), ['en', 'fr'])
    assert.equal(calls.length, 1)
  })

  test('pageBatch() asks for one ordered window of one locale of one site', async () => {
    const seen: Record<string, any> = {}
    ;(globalThis as any).WIKI.db = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: () => ({
              limit: (limit: number) => {
                seen.limit = limit
                return {
                  offset: async (offset: number) => {
                    seen.offset = offset
                    return [{ id: 'p1' }]
                  }
                }
              }
            })
          })
        })
      })
    }

    const rows = await defaultPageSource().pageBatch('site-1', 'en', 500, REBUILD_BATCH_SIZE)

    assert.deepEqual(rows, [{ id: 'p1' }] as any)
    assert.equal(seen.limit, REBUILD_BATCH_SIZE)
    assert.equal(seen.offset, 500)
  })

  test('REBUILD_BATCH_SIZE is the one batch size both bulk-indexing engines page by', () => {
    assert.equal(REBUILD_BATCH_SIZE, 500)
  })
})
