import { humanizeDate, isPast } from '@/helpers/datetime'

/**
 * What an API key's row says about itself, shared by `pages/AdminApi.vue` (every key on the
 * instance) and `pages/ProfileApi.vue` (the reader's own personal tokens). The two differ in their
 * vocabulary (API Keys vs Access Tokens) and in what they have loaded to name things with, so these
 * functions take `t`, an `i18nPrefix` and the list to resolve ids against rather than reading a
 * store.
 */

export function isExpired(key) {
  return isPast(key.expiration)
}

/**
 * A key can be in more than one of these states at once — revoked *and* long expired, say — so they
 * are ordered by how much each explains: what somebody did to this one key, then what the
 * certificates did to all of them, then time running out.
 */
export function keyState(key) {
  if (key.isRevoked) {
    return 'revoked'
  }
  if (key.isInvalidated) {
    return 'invalidated'
  }
  return isExpired(key) ? 'expired' : null
}

export function isUsable(key) {
  return keyState(key) === null
}

/**
 * `certificatesGeneratedAt` is when the signing keypair was generated — what an invalidated key is
 * invalidated by. A self-service reader cannot have it (the endpoint holding it needs
 * `manage:system`), which `humanizeDate`'s own `---` covers.
 */
export function stateHint(key, t, { i18nPrefix, certificatesGeneratedAt = null }) {
  const status = keyState(key)
  if (!status) {
    return ''
  }
  return status === 'invalidated'
    ? t(`${i18nPrefix}.invalidatedHint`, { date: humanizeDate(t, certificatesGeneratedAt) })
    : t(`${i18nPrefix}.${status}Hint`)
}

/** A `null` `siteId` is instance-wide; a site since deleted falls back to its id. */
export function siteName(key, sites, { t, i18nPrefix }) {
  if (key.siteId === null) {
    return t(`${i18nPrefix}.newKeySiteAllSites`)
  }
  return sites.find((s) => s.id === key.siteId)?.title ?? key.siteId
}

export function classificationLevelName(id, levels) {
  return levels.find((l) => l.id === id)?.name ?? id
}

/**
 * Only for a key that restricts classifications: a `null` `allowedClassifications` is unrestricted
 * and each page's template renders no line at all for it, so it never reaches here.
 */
export function classificationLevelNames(key, levels) {
  return key.allowedClassifications.map((id) => classificationLevelName(id, levels)).join(', ')
}
