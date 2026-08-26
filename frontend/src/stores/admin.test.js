import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { useAdminStore } from './admin.js'

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('admin store: versionStatus', () => {
  it('reports pending while both versions are still the seeded n/a', () => {
    const store = useAdminStore()

    expect(store.info.currentVersion).toBe('n/a')
    expect(store.info.latestVersion).toBe('n/a')
    expect(store.versionStatus).toBe('pending')
  })

  it('reports pending when only one side has answered', () => {
    const store = useAdminStore()
    store.info.currentVersion = '3.0.0'

    expect(store.versionStatus).toBe('pending')
  })

  it('reports latest when current is at or ahead of latest', () => {
    const store = useAdminStore()
    store.info.currentVersion = '3.1.0'
    store.info.latestVersion = '3.1.0'

    expect(store.versionStatus).toBe('latest')
    expect(store.isVersionLatest).toBe(true)
  })

  it('reports outdated when current is behind latest', () => {
    const store = useAdminStore()
    store.info.currentVersion = '3.0.0'
    store.info.latestVersion = '3.1.0'

    expect(store.versionStatus).toBe('outdated')
    expect(store.isVersionLatest).toBe(false)
  })

  it('compares semver-aware rather than string-aware for a prerelease/patch pair', () => {
    const store = useAdminStore()
    // -> A plain string compare would call '3.0.0-alpha.1' >= '3.0.0-alpha.10' true (lexicographic
    //    '1' > '1' ties, then string compare stops), but semver correctly ranks alpha.10 higher.
    store.info.currentVersion = '3.0.0-alpha.1'
    store.info.latestVersion = '3.0.0-alpha.10'

    expect(store.versionStatus).toBe('outdated')

    // -> Same pair reversed: current genuinely is ahead
    store.info.currentVersion = '3.0.0-alpha.10'
    store.info.latestVersion = '3.0.0-alpha.1'

    expect(store.versionStatus).toBe('latest')

    // -> A patch bump that a naive string compare ('3.0.9' vs '3.0.10') would rank the wrong way
    store.info.currentVersion = '3.0.10'
    store.info.latestVersion = '3.0.9'

    expect(store.versionStatus).toBe('latest')
  })
})
