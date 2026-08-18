import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'

const BASE_YML_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'base.yml')

/**
 * Regression coverage for task 489: `base.yml`'s `editors.code` block is what `core/config.ts` merges
 * in as the site's default config for the code editor — same mechanism `editors.markdown`/`wysiwyg`
 * already use. Reads the real file rather than a fixture copy, so this fails the moment the block is
 * missing, renamed, or given the wrong `contentType`.
 */
test('base.yml declares the code editor with html as its content type', async () => {
  const raw = await fs.readFile(BASE_YML_PATH, 'utf8')
  const parsed = load(raw) as any

  assert.ok(parsed.editors.code, 'editors.code is missing from base.yml')
  assert.equal(parsed.editors.code.contentType, 'html')
  assert.deepEqual(parsed.editors.code.config, {})
})

/**
 * Regression coverage for task 491: `base.yml` used to declare `editors.asciidoc.contentType: html`
 * while `models/pages.ts`'s `EDITOR_CONTENT_TYPES.asciidoc` mapped to `'asciidoc'` -- two disagreeing
 * sources of truth for what an asciidoc-edited page's `contentType` column actually holds. This locks
 * `base.yml`'s side of that agreement in place; `models/pages.test.ts`'s DB-backed
 * "createPage stores the asciidoc editor content as asciidoc" test locks the other side, so the two
 * together fail the moment either source drifts from the other again.
 */
test('base.yml declares the asciidoc editor with asciidoc as its content type', async () => {
  const raw = await fs.readFile(BASE_YML_PATH, 'utf8')
  const parsed = load(raw) as any

  assert.ok(parsed.editors.asciidoc, 'editors.asciidoc is missing from base.yml')
  assert.equal(parsed.editors.asciidoc.contentType, 'asciidoc')
  assert.deepEqual(parsed.editors.asciidoc.config, {})
})
