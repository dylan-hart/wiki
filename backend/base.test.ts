import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { load } from 'js-yaml'

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
