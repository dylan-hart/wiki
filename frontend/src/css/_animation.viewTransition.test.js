import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * OpenProject #2747/#2750: the free default cross-document crossfade for the post-login hard
 * navigation. `@view-transition` has no selector and nothing mountable to inspect at runtime (it
 * governs the browser's own document-swap behaviour, not anything Vue renders), so -- the same
 * convention `_page-contents.test.js` already uses for `ul.links-list` -- this asserts the compiled
 * source directly rather than a computed style.
 */
describe('_animation.scss @view-transition', () => {
  const dir = dirname(fileURLToPath(import.meta.url))
  const source = readFileSync(join(dir, '_animation.scss'), 'utf-8')

  it('opts every document navigation into the default crossfade, with no named view-transition-names', () => {
    expect(source).toMatch(/@view-transition\s*\{\s*navigation:\s*auto;?\s*\}/)
    expect(source).not.toMatch(/view-transition-name/)
  })
})
