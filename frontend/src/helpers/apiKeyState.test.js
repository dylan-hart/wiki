import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  classificationLevelName,
  classificationLevelNames,
  isExpired,
  isUsable,
  keyState,
  siteName,
  stateHint
} from './apiKeyState'

/** Far enough either side of now that the test can never straddle the boundary. */
const FUTURE = '2099-01-01T00:00:00.000Z'
const PAST = '2000-01-01T00:00:00.000Z'

/** Stands in for `useI18n()`'s `t`: echoes the key, with the interpolated values appended. */
const t = (key, values) => (values ? `${key}:${JSON.stringify(values)}` : key)

const key = (extra = {}) => ({
  expiration: FUTURE,
  isRevoked: false,
  isInvalidated: false,
  siteId: null,
  allowedClassifications: [],
  ...extra
})

// -> `stateHint` dates its invalidated case through `humanizeDate`, which reads the user store
beforeEach(() => {
  setActivePinia(createPinia())
})

describe('isExpired', () => {
  it('is false for a key whose expiration is still ahead', () => {
    expect(isExpired(key())).toBe(false)
  })

  it('is true for a key whose expiration has passed', () => {
    expect(isExpired(key({ expiration: PAST }))).toBe(true)
  })
})

describe('keyState', () => {
  it('is null for a key that works', () => {
    expect(keyState(key())).toBe(null)
  })

  it('reports revocation ahead of everything else', () => {
    expect(keyState(key({ isRevoked: true, isInvalidated: true, expiration: PAST }))).toBe(
      'revoked'
    )
  })

  it('reports invalidation ahead of expiry', () => {
    expect(keyState(key({ isInvalidated: true, expiration: PAST }))).toBe('invalidated')
  })

  it('reports expiry when nothing was done to the key itself', () => {
    expect(keyState(key({ expiration: PAST }))).toBe('expired')
  })
})

describe('isUsable', () => {
  it('is true only when the key is in no failing state at all', () => {
    expect(isUsable(key())).toBe(true)
    expect(isUsable(key({ isRevoked: true }))).toBe(false)
    expect(isUsable(key({ isInvalidated: true }))).toBe(false)
    expect(isUsable(key({ expiration: PAST }))).toBe(false)
  })
})

describe('stateHint', () => {
  it('says nothing about a key that works', () => {
    expect(stateHint(key(), t, { i18nPrefix: 'admin.api' })).toBe('')
  })

  it('names the state under the caller-given prefix', () => {
    expect(stateHint(key({ isRevoked: true }), t, { i18nPrefix: 'admin.api' })).toBe(
      'admin.api.revokedHint'
    )
    expect(stateHint(key({ expiration: PAST }), t, { i18nPrefix: 'profile.api' })).toBe(
      'profile.api.expiredHint'
    )
  })

  it('dates the invalidated hint from when the certificates were regenerated', () => {
    const hint = stateHint(key({ isInvalidated: true }), t, {
      i18nPrefix: 'admin.api',
      certificatesGeneratedAt: '2026-03-04T12:00:00.000Z'
    })
    expect(hint.startsWith('admin.api.invalidatedHint:')).toBe(true)
    expect(hint).toContain('date')
  })
})

describe('siteName', () => {
  const sites = [{ id: 'site-1', title: 'Docs' }]

  it('calls a key pinned to no site instance-wide', () => {
    expect(siteName(key(), sites, { t, i18nPrefix: 'admin.api' })).toBe(
      'admin.api.newKeySiteAllSites'
    )
  })

  it('names the site a key is pinned to', () => {
    expect(siteName(key({ siteId: 'site-1' }), sites, { t, i18nPrefix: 'admin.api' })).toBe('Docs')
  })

  it('falls back to the id for a site that has since been deleted', () => {
    expect(siteName(key({ siteId: 'gone' }), sites, { t, i18nPrefix: 'profile.api' })).toBe('gone')
  })
})

describe('classificationLevelName(s)', () => {
  const levels = [
    { id: 'l1', name: 'Public' },
    { id: 'l2', name: 'Restricted' }
  ]

  it('names a level by id', () => {
    expect(classificationLevelName('l1', levels)).toBe('Public')
  })

  it('falls back to the id for a level since deleted', () => {
    expect(classificationLevelName('gone', levels)).toBe('gone')
  })

  it('joins a key’s allowed levels by name', () => {
    expect(classificationLevelNames(key({ allowedClassifications: ['l2', 'l1'] }), levels)).toBe(
      'Restricted, Public'
    )
  })

  it('renders an empty allow-list as an empty string', () => {
    expect(classificationLevelNames(key(), levels)).toBe('')
  })
})
