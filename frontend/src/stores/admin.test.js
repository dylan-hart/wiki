import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

import { useAdminStore } from './admin.js'

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('admin store: versionStatus / isVersionLatest', () => {
  it('is pending before either version has been fetched', () => {
    const store = useAdminStore()

    expect(store.versionStatus).toBe('pending')
    expect(store.isVersionLatest).toBe(false)
  })

  it('is pending while either version is still the n/a placeholder', () => {
    const store = useAdminStore()
    store.info.currentVersion = '3.0.0'
    store.info.latestVersion = 'n/a'

    expect(store.versionStatus).toBe('pending')
  })

  it('is latest when the current version is greater than or equal to the latest', () => {
    const store = useAdminStore()
    store.info.currentVersion = '3.1.0'
    store.info.latestVersion = '3.0.0'

    expect(store.versionStatus).toBe('latest')
    expect(store.isVersionLatest).toBe(true)
  })

  it('is latest when the current version equals the latest', () => {
    const store = useAdminStore()
    store.info.currentVersion = '3.0.0'
    store.info.latestVersion = '3.0.0'

    expect(store.versionStatus).toBe('latest')
  })

  it('is outdated when the current version is behind the latest', () => {
    const store = useAdminStore()
    store.info.currentVersion = '2.9.0'
    store.info.latestVersion = '3.0.0'

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
