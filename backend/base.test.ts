import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { load } from 'js-yaml'
import { DEFAULT_AUDIT_LOG_RETENTION_DAYS } from './models/auditLog.ts'

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

/**
 * Regression coverage for OpenProject #2005: `base.yml`'s `defaults.config` is the only backstop for
 * a `settings` key an existing database predates (`core/config.ts` merges it under whatever the DB
 * row provides) -- `auditLog.retentionDays` didn't declare one, so a database whose `settings` table
 * was created before `models/settings.ts#init()` started seeding an `auditLog` row would have no
 * fallback at all. Locks the fallback in place and pins it to the same default `models/auditLog.ts`
 * seeds a fresh install with, so the two can never silently drift apart.
 */
test('base.yml declares an auditLog.retentionDays default matching DEFAULT_AUDIT_LOG_RETENTION_DAYS', async () => {
  const raw = await fs.readFile(BASE_YML_PATH, 'utf8')
  const parsed = load(raw) as any

  assert.equal(parsed.defaults?.config?.auditLog?.retentionDays, DEFAULT_AUDIT_LOG_RETENTION_DAYS)
})

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
