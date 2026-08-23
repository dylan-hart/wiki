import { after, before, beforeEach, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ExtensionDefinition } from './extensions.ts'
import { detectImportFormat } from './import.ts'

const execFileAsync = promisify(execFile)

/** Whether a real `pandoc` binary is on PATH, for the one test that shells out to it for real. */
async function hasPandoc(): Promise<boolean> {
  try {
    await execFileAsync('pandoc', ['--version'])
    return true
  } catch {
    return false
  }
}

// -> Resolved once, at module load (top-level await is fine here — this is ESM), so `describe`'s own
//    callback can stay synchronous and every `test(...)` call is a plain declarative registration.
const pandocAvailable = await hasPandoc()

const PANDOC_DEFINITION: ExtensionDefinition = {
  key: 'pandoc',
  title: 'Pandoc',
  description: 'Converts between markup formats.',
  detect: { type: 'command', value: 'pandoc' },
  isInstallable: false
}

/**
 * `models/import.ts` guards on `WIKI.models.extensions`, exactly the way `models/rendering.ts`'s
 * `ensureCanRender` guards on Puppeteer — so the extensions model is stubbed here rather than pulled
 * in for real, and `runPandoc` (the one method that actually shells out) is mocked per test so the
 * business logic — format validation, size limits, "no usable content", error surfacing — is
 * verified without a real pandoc binary on the machine running the test. The one test that does need
 * a real conversion is skipped when pandoc isn't installed, the same way DB-backed suites skip
 * without `DATABASE_URL` (see `test/db.ts`).
 */
describe('page import (pandoc)', () => {
  let isInstalled: ReturnType<typeof mock.fn>
  let pageImport: typeof import('./import.ts').pageImport

  before(async () => {
    ;(globalThis as any).WIKI = {
      models: {
        extensions: {
          getDefinition: mock.fn((key: string) => (key === 'pandoc' ? PANDOC_DEFINITION : null)),
          isInstalled: mock.fn(async () => true)
        }
      }
    }
    ;({ pageImport } = await import('./import.ts'))
    isInstalled = (globalThis as any).WIKI.models.extensions.isInstalled
  })

  after(() => {
    delete (globalThis as any).WIKI
  })

  beforeEach(() => {
    isInstalled.mock.resetCalls()
    isInstalled.mock.mockImplementation(async () => true)
  })

  test('refuses when pandoc is not installed, same shape as renderPuppeteerMissing', async () => {
    isInstalled.mock.mockImplementation(async () => false)

    await assert.rejects(
      pageImport.convertToMarkdown({ format: 'mediawiki', data: Buffer.from('= Hi =') }),
      (err: any) => {
        assert.equal(err.name, 'importPandocMissing')
        assert.equal(err.statusCode, 503)
        return true
      }
    )
  })

  test('refuses an unsupported format', async () => {
    await assert.rejects(
      pageImport.convertToMarkdown({ format: 'wordperfect', data: Buffer.from('nope') }),
      (err: any) => {
        assert.equal(err.name, 'importUnsupportedFormat')
        assert.equal(err.statusCode, 400)
        assert.match(err.message, /wordperfect/)
        return true
      }
    )
  })

  test('refuses an empty file', async () => {
    await assert.rejects(
      pageImport.convertToMarkdown({ format: 'mediawiki', data: Buffer.alloc(0) }),
      (err: any) => {
        assert.equal(err.name, 'importEmptyFile')
        return true
      }
    )
  })

  test("threads pandoc's own stderr through when the file is not valid input for the declared format", async () => {
    const runPandoc = mock.method(pageImport as any, 'runPandoc', async () => {
      throw {
        name: 'importConversionFailed',
        statusCode: 400,
        message:
          'Pandoc could not convert this file as docx: Malformed docx file, could not be parsed'
      }
    })

    try {
      await assert.rejects(
        pageImport.convertToMarkdown({ format: 'docx', data: Buffer.from('not a real docx') }),
        (err: any) => {
          assert.equal(err.name, 'importConversionFailed')
          assert.equal(err.statusCode, 400)
          assert.match(err.message, /Malformed docx file/)
          return true
        }
      )
    } finally {
      runPandoc.mock.restore()
    }
  })

  test('refuses a conversion that produces no usable content', async () => {
    const runPandoc = mock.method(pageImport as any, 'runPandoc', async () => '   \n\n  ')

    try {
      await assert.rejects(
        pageImport.convertToMarkdown({ format: 'rst', data: Buffer.from('...') }),
        (err: any) => {
          assert.equal(err.name, 'importNoContent')
          assert.equal(err.statusCode, 400)
          return true
        }
      )
    } finally {
      runPandoc.mock.restore()
    }
  })

  test('returns the converted markdown on success', async () => {
    const runPandoc = mock.method(
      pageImport as any,
      'runPandoc',
      async () => '# Hello\n\nSome content.\n'
    )

    try {
      const result = await pageImport.convertToMarkdown({
        format: 'mediawiki',
        data: Buffer.from('= Hello =\n\nSome content.')
      })
      assert.deepEqual(result, { markdown: '# Hello\n\nSome content.\n' })
    } finally {
      runPandoc.mock.restore()
    }
  })

  test(
    'converts a real MediaWiki snippet with the real pandoc binary',
    { skip: !pandocAvailable },
    async () => {
      const result = await pageImport.convertToMarkdown({
        format: 'mediawiki',
        data: Buffer.from("== Hello ==\n\nSome '''bold''' content.\n")
      })
      assert.match(result.markdown, /^#+ Hello/m)
      assert.match(result.markdown, /\*\*bold\*\*/)
    }
  )
})

/**
 * `format: 'markdown'` (OpenProject #1092) is a pass-through, never reaching `ensureCanImport` or
 * `runPandoc` — verified below by leaving `isInstalled` mocked `false` for the whole suite and never
 * touching `runPandoc` at all, unlike the Pandoc-backed suite above.
 */
describe('page import (markdown pass-through)', () => {
  let pageImport: typeof import('./import.ts').pageImport

  before(async () => {
    ;(globalThis as any).WIKI = {
      models: {
        extensions: {
          getDefinition: mock.fn((key: string) => (key === 'pandoc' ? PANDOC_DEFINITION : null)),
          // -> Deliberately false for this whole suite: a markdown import must never need Pandoc.
          isInstalled: mock.fn(async () => false)
        }
      }
    }
    ;({ pageImport } = await import('./import.ts'))
  })

  after(() => {
    delete (globalThis as any).WIKI
  })

  test('converts with no front matter as a plain pass-through', async () => {
    const result = await pageImport.convertToMarkdown({
      format: 'markdown',
      data: Buffer.from('# Hello\n\nJust a page.\n')
    })
    assert.deepEqual(result, { markdown: '# Hello\n\nJust a page.\n' })
  })

  test('splits a leading YAML front-matter block into title/description/tags', async () => {
    const source = [
      '---',
      'title: My Imported Page',
      'description: A short summary',
      'tags:',
      '  - alpha',
      '  - beta',
      '---',
      '',
      '# Body\n\nContent here.\n'
    ].join('\n')

    const result = await pageImport.convertToMarkdown({
      format: 'markdown',
      data: Buffer.from(source)
    })
    assert.equal(result.title, 'My Imported Page')
    assert.equal(result.description, 'A short summary')
    assert.deepEqual(result.tags, ['alpha', 'beta'])
    assert.equal(result.markdown, '# Body\n\nContent here.\n')
  })

  test('strips a leading UTF-8 BOM before parsing front matter (Windows-exported files)', async () => {
    const source = '﻿' + ['---', 'title: BOM Page', '---', '', 'Body.\n'].join('\n')

    const result = await pageImport.convertToMarkdown({
      format: 'markdown',
      data: Buffer.from(source, 'utf8')
    })
    assert.equal(result.title, 'BOM Page')
    assert.equal(result.markdown, 'Body.\n')
  })

  test('strips a leading UTF-8 BOM even with no front matter present', async () => {
    const result = await pageImport.convertToMarkdown({
      format: 'markdown',
      data: Buffer.from('﻿# Hello\n\nJust a page.\n', 'utf8')
    })
    assert.deepEqual(result, { markdown: '# Hello\n\nJust a page.\n' })
  })

  test('refuses an empty file', async () => {
    await assert.rejects(
      pageImport.convertToMarkdown({ format: 'markdown', data: Buffer.alloc(0) }),
      (err: any) => {
        assert.equal(err.name, 'importEmptyFile')
        return true
      }
    )
  })

  test('refuses a whitespace-only file', async () => {
    await assert.rejects(
      pageImport.convertToMarkdown({ format: 'markdown', data: Buffer.from('   \n\n  ') }),
      (err: any) => {
        assert.equal(err.name, 'importNoContent')
        assert.equal(err.statusCode, 400)
        return true
      }
    )
  })
})

describe('detectImportFormat (OpenProject #1209)', () => {
  test('resolves markdown formats from .md and .markdown', () => {
    assert.equal(detectImportFormat('notes.md'), 'markdown')
    assert.equal(detectImportFormat('notes.markdown'), 'markdown')
  })

  test('resolves every pandoc-backed extension to its format', () => {
    assert.equal(detectImportFormat('page.wiki'), 'mediawiki')
    assert.equal(detectImportFormat('page.mediawiki'), 'mediawiki')
    assert.equal(detectImportFormat('page.textile'), 'textile')
    assert.equal(detectImportFormat('page.dbk'), 'docbook')
    assert.equal(detectImportFormat('page.docbook'), 'docbook')
    assert.equal(detectImportFormat('page.rst'), 'rst')
    assert.equal(detectImportFormat('page.docx'), 'docx')
    assert.equal(detectImportFormat('page.odt'), 'odt')
  })

  test('is case-insensitive on the extension', () => {
    assert.equal(detectImportFormat('NOTES.MD'), 'markdown')
    assert.equal(detectImportFormat('Report.DOCX'), 'docx')
  })

  test('returns null for an unrecognized extension', () => {
    assert.equal(detectImportFormat('archive.zip'), null)
  })

  test('returns null for a file with no extension at all', () => {
    assert.equal(detectImportFormat('README'), null)
  })

  test('uses only the last extension of a multi-dot file name', () => {
    assert.equal(detectImportFormat('notes.v2.md'), 'markdown')
  })
})
