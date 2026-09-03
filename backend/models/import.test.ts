import { after, before, beforeEach, describe, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { ExtensionDefinition } from './extensions.ts'
import { buildPandocArgs, detectImportFormat, MAX_CONCURRENT_PANDOC, pandocCwd } from './import.ts'

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
 * `models/import.ts` guards on `WIKI.models.extensions`, exactly the way `models/renderQueue.ts`'s
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

/**
 * OpenProject #2191: `rst` and `docbook` both implement file-inclusion directives pandoc would
 * otherwise honor, and no `cwd` meant a relative include could reach `config.yml` next to the repo
 * root. The argv actually spawned *is* the whole security boundary here (per the module's own header
 * comment on `execFile` vs `exec`), so these assert on the pure argv/cwd builders directly rather
 * than mocking `execFile` or the `node:child_process` module.
 */
describe('runPandoc argv (OpenProject #2191: --sandbox)', () => {
  const repoRoot = path.resolve(import.meta.dirname, '..', '..')

  test('every pandoc-backed format is spawned with --sandbox', () => {
    for (const format of ['mediawiki', 'textile', 'docbook', 'rst', 'docx', 'odt'] as const) {
      assert.ok(
        buildPandocArgs(format).includes('--sandbox'),
        `expected --sandbox in argv for format ${format}`
      )
    }
  })

  test('the -f value passed to pandoc is the requested format', () => {
    assert.deepEqual(buildPandocArgs('rst'), ['-f', 'rst', '-t', 'gfm', '--wrap=none', '--sandbox'])
  })

  test('pandoc is spawned outside the repo root, with nothing sensitive in reach', () => {
    const cwd = pandocCwd()
    assert.notEqual(cwd, repoRoot)
    assert.equal(path.relative(repoRoot, cwd).startsWith('..'), true)
    assert.equal(cwd, tmpdir())
  })
})

/**
 * OpenProject #2209/#2192: `runPandoc` gates every call through a process-wide concurrency ceiling
 * (`MAX_CONCURRENT_PANDOC`), so `execPandoc` — the actual spawn, mocked here — is asserted to never
 * have more than that many invocations in flight at once, however many callers invoke `runPandoc`
 * concurrently, and that a rejected conversion still frees its slot for the next caller.
 */
describe('page import (pandoc concurrency gate, #2209)', () => {
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
  })

  after(() => {
    delete (globalThis as any).WIKI
  })

  test('never runs more than MAX_CONCURRENT_PANDOC conversions at once', async () => {
    let inFlight = 0
    let maxObserved = 0
    const execPandoc = mock.method(pageImport as any, 'execPandoc', async () => {
      inFlight++
      maxObserved = Math.max(maxObserved, inFlight)
      // -> Yield long enough that every caller has had a chance to queue up behind the gate
      await new Promise((resolve) => setTimeout(resolve, 20))
      inFlight--
      return 'converted'
    })

    try {
      const callerCount = MAX_CONCURRENT_PANDOC * 3
      await Promise.all(
        Array.from({ length: callerCount }, () =>
          (pageImport as any).runPandoc('mediawiki', Buffer.from('= x ='))
        )
      )
      assert.equal(execPandoc.mock.calls.length, callerCount)
      assert.ok(
        maxObserved <= MAX_CONCURRENT_PANDOC,
        `expected at most ${MAX_CONCURRENT_PANDOC} concurrent conversions, observed ${maxObserved}`
      )
      assert.equal(
        maxObserved,
        MAX_CONCURRENT_PANDOC,
        'the gate should also be fully used, not idle'
      )
    } finally {
      execPandoc.mock.restore()
    }
  })

  test('releases the slot when a conversion fails, so the next caller is not stuck queued', async () => {
    const execPandoc = mock.method(pageImport as any, 'execPandoc', async () => {
      throw new Error('pandoc exploded')
    })

    try {
      // -> Fill and fail every slot
      await Promise.all(
        Array.from({ length: MAX_CONCURRENT_PANDOC }, () =>
          (pageImport as any).runPandoc('mediawiki', Buffer.from('= x =')).catch(() => {})
        )
      )

      // -> A slot freed by a failure must be immediately usable, not leaked
      execPandoc.mock.mockImplementation(async () => 'recovered')
      const result = await (pageImport as any).runPandoc('mediawiki', Buffer.from('= x ='))
      assert.equal(result, 'recovered')
    } finally {
      execPandoc.mock.restore()
    }
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
