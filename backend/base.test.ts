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
