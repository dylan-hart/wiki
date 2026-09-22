import { sql } from 'drizzle-orm'
import { assets as assetsTable } from '../db/schema.ts'
import type { WikiDb } from '../core/db.ts'

export interface PdfTextLimits {
  maxBytes: number
  maxPages: number
  maxChars: number
  timeoutMs: number
}

export const PDF_TEXT_LIMITS: PdfTextLimits = {
  maxBytes: 50 * 1024 * 1024,
  maxPages: 200,
  maxChars: 500_000,
  timeoutMs: 30_000
}

export type PdfTextOutcome = 'ok' | 'empty' | 'failed' | 'skipped'

export interface PdfTextResult {
  text: string
  outcome: PdfTextOutcome
  reason?: string
  truncated: boolean
}

class ExtractionTimeout extends Error {
  constructor() {
    super('timeout')
    this.name = 'ExtractionTimeout'
  }
}

export async function extractPdfText(
  bytes: Uint8Array,
  limits: PdfTextLimits = PDF_TEXT_LIMITS
): Promise<PdfTextResult> {
  if (bytes.length > limits.maxBytes) {
    return { text: '', outcome: 'skipped', reason: 'too-large', truncated: false }
  }

  let doc: Awaited<ReturnType<typeof import('unpdf').getDocumentProxy>> | undefined
  let timer: NodeJS.Timeout | undefined
  let expired = false

  const run = async (): Promise<PdfTextResult> => {
    const { getDocumentProxy } = await import('unpdf')
    doc = await getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 })
    const pageCount = Math.min(doc.numPages, limits.maxPages)
    const parts: string[] = []
    let chars = 0
    let truncated = doc.numPages > limits.maxPages

    for (let n = 1; n <= pageCount; n++) {
      await new Promise<void>((resolve) => setImmediate(resolve))
      if (expired) {
        throw new ExtractionTimeout()
      }
      const page = await doc.getPage(n)
      const content = await page.getTextContent()
      page.cleanup()
      let pageText = ''
      for (const item of content.items) {
        if ('str' in item) {
          pageText += item.str
          if (item.hasEOL) {
            pageText += '\n'
          }
        }
      }
      pageText = pageText.trim()
      if (!pageText) {
        continue
      }
      parts.push(pageText)
      chars += pageText.length + 1
      if (chars >= limits.maxChars) {
        truncated = true
        break
      }
    }

    let text = parts.join('\n')
    if (text.length > limits.maxChars) {
      text = text.slice(0, limits.maxChars)
      truncated = true
    }
    text = text.replaceAll('\u0000', '').trim()
    return { text, outcome: text ? 'ok' : 'empty', truncated }
  }

  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      expired = true
      reject(new ExtractionTimeout())
    }, limits.timeoutMs)
    timer.unref()
  })

  try {
    return await Promise.race([run(), timeout])
  } catch (err) {
    return {
      text: '',
      outcome: 'failed',
      reason: err instanceof Error && err.name ? err.name : 'unknown',
      truncated: false
    }
  } finally {
    clearTimeout(timer)
    doc?.loadingTask.destroy().catch(() => {})
  }
}

export async function storeAssetText(
  db: WikiDb,
  assetId: string,
  expectedUpdatedAt: string,
  text: string
): Promise<boolean> {
  const content = text.trim() ? text : null
  const updated = await db
    .update(assetsTable)
    .set({
      searchContent: content,
      ts: content === null ? null : sql`to_tsvector('simple', ${content}::text)`
    })
    .where(
      sql`${assetsTable.id} = ${assetId} AND ${assetsTable.updatedAt}::text = ${expectedUpdatedAt}`
    )
    .returning({ id: assetsTable.id })
  return updated.length > 0
}
