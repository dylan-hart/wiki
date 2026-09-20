import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC_ROOT = dirname(fileURLToPath(import.meta.url))
const catalogue = JSON.parse(readFileSync(join(SRC_ROOT, '../../backend/locales/en.json'), 'utf-8'))

const SURFACES = [
  'components/UserProfilePopover.vue',
  'components/ProfileVisibilityToggle.vue',
  'components/UserProfileVisibilityMenu.vue',
  'components/ProfileOverlay.vue',
  'components/PageComments.vue',
  'pages/ProfileInfo.vue',
  'pages/AdminUsers.vue',
  'pages/Index.vue'
]

const STATIC_KEY = /\bt\(\s*(['"`])([A-Za-z][\w.-]*\.[\w.-]+)\1/g

function staticKeysIn(relativePath) {
  const source = readFileSync(join(SRC_ROOT, relativePath), 'utf-8')
  return [...source.matchAll(STATIC_KEY)].map((match) => match[2])
}

describe('readonly profile locale strings', () => {
  for (const surface of SURFACES) {
    it(`${surface} only names keys that exist in backend/locales/en.json`, () => {
      const keys = staticKeysIn(surface)
      expect(keys.length).toBeGreaterThan(0)
      expect(keys.filter((key) => !(key in catalogue))).toEqual([])
    })
  }

  it('carries every profilePopover.* key the popover and its openers use', () => {
    const used = new Set(
      ['components/UserProfilePopover.vue', 'components/PageComments.vue', 'pages/Index.vue']
        .flatMap(staticKeysIn)
        .filter((key) => key.startsWith('profilePopover.'))
    )
    expect(used.has('profilePopover.avatarLabel')).toBe(true)
    expect(used.has('profilePopover.loading')).toBe(true)
    for (const key of used) {
      expect(catalogue[key], key).toEqual(expect.any(String))
      expect(catalogue[key].trim(), key).not.toBe('')
    }
  })

  it('names the popover errors and field labels the component chooses between dynamically', () => {
    for (const key of [
      'profilePopover.unauthorized',
      'profilePopover.notFound',
      'profilePopover.failed',
      'profilePopover.fieldLocation',
      'profilePopover.fieldJobTitle',
      'profilePopover.fieldPronouns'
    ]) {
      expect(catalogue[key], key).toEqual(expect.any(String))
    }
  })
})
