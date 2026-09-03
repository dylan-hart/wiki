import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Guards work package #2432 — the built-in `markdown-it-attrs` classes this fork actually styles
 * ({.links-list}, the three table-* classes, the three align-* classes) used to exist only as SCSS
 * comments, with zero documentation anywhere an author would look. This asserts the reference doc
 * exists, names every one of those classes, and stays cross-checked against the actual class
 * selectors in `frontend/src/css/_page-contents.scss` so the doc can't silently drift from the
 * styling it describes.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.join(HERE, '../..')
const DOC_PATH = path.join(REPO_ROOT, 'docs', 'markdown-syntax.md')
const SCSS_PATH = path.join(REPO_ROOT, 'frontend', 'src', 'css', '_page-contents.scss')

const BUILT_IN_CLASSES = [
  'links-list',
  'table-leading-col',
  'table-code-nohighlight',
  'table-vertical-middle',
  'align-left',
  'align-right',
  'align-center'
]

describe('markdown-syntax reference doc (work package #2432)', () => {
  test('docs/markdown-syntax.md exists and documents every built-in class', async () => {
    const doc = await readFile(DOC_PATH, 'utf8')
    for (const cls of BUILT_IN_CLASSES) {
      assert.ok(
        doc.includes(`{.${cls}}`) || doc.includes(`.${cls}`),
        `docs/markdown-syntax.md is missing the built-in class "${cls}"`
      )
    }
  })

  test('each documented class still exists as a real selector in _page-contents.scss', async () => {
    const scss = await readFile(SCSS_PATH, 'utf8')
    for (const cls of BUILT_IN_CLASSES) {
      assert.ok(
        scss.includes(`.${cls}`),
        `frontend/src/css/_page-contents.scss no longer defines .${cls} — docs/markdown-syntax.md is now stale`
      )
    }
  })

  test('{.grid-list} is explicitly called out as not real, not documented as a real class', async () => {
    const doc = await readFile(DOC_PATH, 'utf8')
    assert.ok(doc.includes('grid-list'), 'expected docs/markdown-syntax.md to mention grid-list')
    assert.ok(
      /does not exist/i.test(doc),
      'expected docs/markdown-syntax.md to state that grid-list does not exist in this fork'
    )
    const scss = await readFile(SCSS_PATH, 'utf8')
    assert.ok(
      !scss.includes('grid-list'),
      'grid-list unexpectedly has real styling now — update the doc'
    )
  })

  test('documents the allowed markdown-it-attrs attributes actually configured in markdown.js', async () => {
    const doc = await readFile(DOC_PATH, 'utf8')
    const rendererSrc = await readFile(
      path.join(REPO_ROOT, 'frontend', 'src', 'renderers', 'markdown.js'),
      'utf8'
    )
    const match = rendererSrc.match(/allowedAttributes:\s*\[([^\]]+)]/)
    assert.ok(match, 'expected to find allowedAttributes in frontend/src/renderers/markdown.js')
    const allowed = match![1]
      .split(',')
      .map((s) => s.trim().replace(/['"]/g, ''))
      .filter(Boolean)
    for (const attr of allowed) {
      assert.ok(
        doc.includes(attr),
        `docs/markdown-syntax.md should mention the allowed attribute "${attr}"`
      )
    }
  })

  test('notes that {.links-list} is for bulleted lists only', async () => {
    const doc = await readFile(DOC_PATH, 'utf8')
    assert.ok(
      /bulleted.*only/i.test(doc),
      'docs/markdown-syntax.md should call out that {.links-list} is for bulleted lists only'
    )
  })

  test('notes that the align-* classes only style images/figures', async () => {
    const doc = await readFile(DOC_PATH, 'utf8')
    assert.ok(
      /images? and figures? only/i.test(doc) || /image or figure/i.test(doc),
      'docs/markdown-syntax.md should call out that align-* classes only affect images/figures'
    )
  })
})
