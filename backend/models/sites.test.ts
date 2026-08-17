import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { load } from 'js-yaml'

/**
 * Regression test for the dead `kroki`/`plantuml` config surface: `base.yml`'s
 * `editors.markdown.config` carried `kroki: true` and `plantuml: true` even though nothing in the
 * codebase ever read either key — diagram rendering moved to `block-kroki`/`block-plantuml`, which
 * take their server/language settings as block props on the page, not from site-wide config. Locks
 * the keys gone so they cannot silently reappear.
 *
 * `latexEngine` is deliberately left alone here: it's real (if currently inert) config surface that
 * Feature 366 ("Math Rendering Parity & Engine Selection") owns the future of, so this task's edit —
 * and this test — must not touch it. The second assertion pins that boundary.
 */

const rootPath = path.resolve(import.meta.dirname, '../..')

test('base.yml no longer carries the dead kroki/plantuml markdown editor config keys', async () => {
  const raw = await readFile(path.join(rootPath, 'backend/base.yml'), 'utf8')
  const parsed = load(raw) as any
  const markdownConfig = parsed.editors.markdown.config

  assert.equal(
    'kroki' in markdownConfig,
    false,
    'base.yml should no longer define editors.markdown.config.kroki'
  )
  assert.equal(
    'plantuml' in markdownConfig,
    false,
    'base.yml should no longer define editors.markdown.config.plantuml'
  )

  // -> Scope guard: task 476 removes kroki/plantuml only. latexEngine belongs to Feature 366/task 618
  // and must still be present, untouched, on this branch.
  assert.equal(
    'latexEngine' in markdownConfig,
    true,
    'latexEngine is out of scope for this task and must remain'
  )
})

test('models/sites.ts default markdown editor config still omits kroki, plantuml and latexEngine', async () => {
  const raw = await readFile(path.join(rootPath, 'backend/models/sites.ts'), 'utf8')

  // -> Both default-config object literals (site creation, and the existing-site default merge in
  // init()) write `markdown: { isActive: true, config: { ...primitives... } }` with no nested object
  // inside `config`, so the text up to the first `}` after `config: {` is exactly that block.
  const markdownConfigBlocks = [
    ...raw.matchAll(/markdown:\s*{\s*isActive:\s*true,\s*config:\s*{([^}]*)}/g)
  ]

  assert.equal(
    markdownConfigBlocks.length,
    2,
    'expected exactly two markdown default-config literals in sites.ts'
  )

  for (const [, body] of markdownConfigBlocks) {
    const keys = [...body.matchAll(/^\s*(\w+):/gm)].map((m) => m[1])
    assert.equal(keys.includes('kroki'), false, 'sites.ts markdown config must not define kroki')
    assert.equal(
      keys.includes('plantuml'),
      false,
      'sites.ts markdown config must not define plantuml'
    )
    assert.equal(
      keys.includes('latexEngine'),
      false,
      'sites.ts markdown config must not define latexEngine'
    )
  }
})
