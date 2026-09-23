import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { PDF_TEXT_LIMITS, extractPdfText, storeAssetText } from './assetText.ts'
import { buildTextPdf } from '../test/pdfFixture.ts'

describe('extractPdfText', () => {
  test('returns the text layer of a text PDF', async () => {
    const result = await extractPdfText(buildTextPdf(['Quarterly revenue forecast']))
    assert.equal(result.outcome, 'ok')
    assert.match(result.text, /Quarterly revenue forecast/)
    assert.equal(result.truncated, false)
  })

  test('reads every page up to the page cap and flags the truncation', async () => {
    const pdf = buildTextPdf(['alpha page', 'beta page', 'gamma page'])
    const result = await extractPdfText(pdf, { ...PDF_TEXT_LIMITS, maxPages: 2 })
    assert.match(result.text, /alpha page/)
    assert.match(result.text, /beta page/)
    assert.doesNotMatch(result.text, /gamma page/)
    assert.equal(result.truncated, true)
  })

  test('cuts the text at the character cap', async () => {
    const pdf = buildTextPdf(['0123456789abcdefghij'])
    const result = await extractPdfText(pdf, { ...PDF_TEXT_LIMITS, maxChars: 10 })
    assert.equal(result.text.length, 10)
    assert.equal(result.truncated, true)
  })

  test('a PDF over the byte cap is skipped without being parsed', async () => {
    const result = await extractPdfText(buildTextPdf(['x']), { ...PDF_TEXT_LIMITS, maxBytes: 10 })
    assert.equal(result.outcome, 'skipped')
    assert.equal(result.text, '')
  })

  test('a corrupt PDF comes back as a failure, not a throw', async () => {
    const result = await extractPdfText(Buffer.from('%PDF-1.4 this is not a real document'))
    assert.equal(result.outcome, 'failed')
    assert.equal(result.text, '')
    assert.ok(result.reason)
  })

  test('bytes that are not a PDF at all come back as a failure', async () => {
    const result = await extractPdfText(Buffer.from('plain text'))
    assert.equal(result.outcome, 'failed')
    assert.equal(result.text, '')
  })

  test('an encrypted PDF comes back as a failure, not a throw', async () => {
    const result = await extractPdfText(buildTextPdf(['secret'], { encrypted: true }))
    assert.equal(result.outcome, 'failed')
    assert.equal(result.text, '')
    assert.doesNotMatch(result.reason ?? '', /secret/)
  })

  test('a PDF with no text layer is empty, distinct from a failure', async () => {
    const result = await extractPdfText(buildTextPdf(['']))
    assert.equal(result.outcome, 'empty')
    assert.equal(result.text, '')
  })

  test('a timeout is reported as a failure', async () => {
    const pages = Array.from({ length: 60 }, (_, i) => `page number ${i}`)
    const result = await extractPdfText(buildTextPdf(pages), {
      ...PDF_TEXT_LIMITS,
      timeoutMs: 1
    })
    assert.equal(result.outcome, 'failed')
    assert.equal(result.reason, 'ExtractionTimeout')
  })
})

describe('storeAssetText', () => {
  const BYTES = Buffer.from('the file the text was read from')

  function stubDb(rows: unknown[]) {
    const sets: any[] = []
    const wheres: any[] = []
    const chain: any = {
      set: (values: any) => {
        sets.push(values)
        return chain
      },
      where: (clause: any) => {
        wheres.push(clause)
        return chain
      },
      returning: async () => rows
    }
    return { db: { update: () => chain } as any, sets, wheres }
  }

  test('stores the text with a vector and reports the write', async () => {
    const { db, sets } = stubDb([{ id: 'a' }])
    assert.equal(await storeAssetText(db, 'a', BYTES, 'hello world'), true)
    assert.equal(sets[0].searchContent, 'hello world')
    assert.notEqual(sets[0].ts, null)
  })

  test('blank text clears both columns', async () => {
    const { db, sets } = stubDb([{ id: 'a' }])
    await storeAssetText(db, 'a', BYTES, ' \n ')
    assert.deepEqual(sets[0], { searchContent: null, ts: null })
  })

  test('reports no write when the asset changed since it was read', async () => {
    const { db } = stubDb([])
    assert.equal(await storeAssetText(db, 'a', BYTES, 'stale'), false)
  })
})
