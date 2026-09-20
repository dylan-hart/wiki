import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * `@view-transition` has no selector and nothing mountable to inspect at runtime -- it governs the
 * browser's own document-swap behaviour, not anything Vue renders -- so this asserts the source
 * directly rather than a computed style.
 */
describe('_animation.css @view-transition', () => {
  const dir = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(dir, '_animation.css'), 'utf-8')

  it('opts every document navigation into the default crossfade, with no named view-transition-names', () => {
    expect(source).toMatch(/@view-transition\s*\{\s*navigation:\s*auto;?\s*\}/)
    expect(source).not.toMatch(/view-transition-name/)
  })
})
