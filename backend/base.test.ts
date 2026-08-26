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

/**
 * Regression test for the dead `editors.markdown.config.latexEngine` key (Feature 366 / Task 618).
 *
 * In 2.5.x, `latexEngine` picked which single markdown-it plugin rendered LaTeX. In 3.x, math
 * rendering is two independently-enableable blocks (`block-katex`, `block-mathjax`), each with its
 * own per-site `isEnabled` flag already exposed through `AdminBlocks.vue` / `models/blocks.ts` — so
 * that per-block toggle *is* the per-site engine choice, and `latexEngine` never had a reader: it
 * was absent from `EditorMarkdownConfigOverlay.vue`'s `defaultConfig()`/template, absent from
 * `models/sites.ts`'s per-site provisioning defaults, and `core/config.ts` only ever merges
 * `appdata.defaults.config` into `WIKI.config` — the sibling `editors:` block in `base.yml` is
 * never read into anything at all. This test locks the key's removal so it isn't reintroduced.
 */

const baseYmlPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'base.yml')

test('base.yml editors.markdown.config has no latexEngine key', async () => {
  const raw = await fs.readFile(baseYmlPath, 'utf8')
  const data = load(raw) as Record<string, any>

  assert.ok(data.editors?.markdown?.config, 'expected editors.markdown.config to exist in base.yml')
  assert.equal(
    Object.hasOwn(data.editors.markdown.config, 'latexEngine'),
    false,
    'latexEngine is dead (superseded by per-block isEnabled on block-katex/block-mathjax) and must not reappear in base.yml'
  )
})

/**
 * Regression coverage for the three dead top-level `defaults.config` keys removed by task 2021
 * (2026-08-24 audit, operability-devex.md §15): `ssl.enabled`, `channel`, `maintainerEmail`. None
 * of the three had a reader anywhere in `backend` or `frontend` -- `ssl.enabled` in particular is
 * actively harmful to keep around, since it reads like the switch for the wiki's own HTTPS listener
 * (which Wiki.js never terminates) even though nothing ever consulted it, right next to the
 * genuinely-read, doc-commented `db.ssl` that configures the Postgres connection's TLS instead.
 * This locks their removal so none of the three reappears in `base.yml`.
 */
test('base.yml has no top-level ssl, channel, or maintainerEmail keys', async () => {
  const raw = await fs.readFile(baseYmlPath, 'utf8')
  const data = load(raw) as Record<string, any>
  const config = data.defaults?.config

  assert.ok(config, 'expected defaults.config to exist in base.yml')
  assert.equal(
    Object.hasOwn(config, 'ssl'),
    false,
    'top-level ssl is dead (never read anywhere) and must not reappear in base.yml -- db.ssl is the real, read TLS setting'
  )
  assert.equal(
    Object.hasOwn(config, 'channel'),
    false,
    'channel is dead (never read anywhere) and must not reappear in base.yml'
  )
  assert.equal(
    Object.hasOwn(config, 'maintainerEmail'),
    false,
    'maintainerEmail is dead (never read anywhere) and must not reappear in base.yml'
  )
})
