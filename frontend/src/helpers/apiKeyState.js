import { humanizeDate, isPast } from '@/helpers/datetime'

/**
 * What an API key's row says about itself, shared by the two screens that list keys —
 * `pages/AdminApi.vue` (every key on the instance) and `pages/ProfileApi.vue` (the reader's own
 * personal tokens).
 *
 * The two pages differ in their vocabulary (`admin.api.*` calls these API Keys, `profile.api.*`
 * calls them Access Tokens) and in what they have loaded to name things with, so the functions that
 * reach for either take them as arguments rather than reading a store: `t` plus an `i18nPrefix`,
 * and the list to resolve an id against.
 */

/** A key past its expiration still authenticates nothing, even though it was never revoked. */
export function isExpired(key) {
  return isPast(key.expiration)
}

/**
 * Why a key does not work, or null when it does.
 *
 * A key can be in more than one of these at once — revoked *and* long expired, say — so they are
 * ordered by how much each explains: what somebody did to this one key, then what the certificates
 * did to all of them, then time running out. `isInvalidated` comes from the server, which is the
 * side holding the date the keypair was generated.
 *
 * @returns {'revoked'|'invalidated'|'expired'|null}
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
 * The sentence under a key's state: what it means, and what to do about it.
 *
 * @param {object} key
 * @param {(key: string, values?: object) => string} t The screen's `useI18n()` translator.
 * @param {object} options
 * @param {string} options.i18nPrefix `admin.api` or `profile.api`.
 * @param {string|null} [options.certificatesGeneratedAt] When the signing keypair was generated —
 *   what an invalidated key is invalidated by. Unavailable to a self-service reader (the endpoint
 *   holding it needs `manage:system`), which `humanizeDate`'s own `---` covers.
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

/**
 * The site a key is pinned to, by title -- `null` is instance-wide ("All Sites"), and a site that
 * has since been deleted falls back to its ID.
 *
 * @param {object} key
 * @param {Array<{ id: string, title: string }>} sites Whatever the screen managed to load.
 * @param {{ t: Function, i18nPrefix: string }} options
 */
export function siteName(key, sites, { t, i18nPrefix }) {
  if (key.siteId === null) {
    return t(`${i18nPrefix}.newKeySiteAllSites`)
  }
  return sites.find((s) => s.id === key.siteId)?.title ?? key.siteId
}

/** A classification level's name, by id -- falling back to the id for a level since deleted. */
export function classificationLevelName(id, levels) {
  return levels.find((l) => l.id === id)?.name ?? id
}

/**
 * A key's `allowedClassifications` (OpenProject #1205), joined by name for display -- `null` is
 * unrestricted, the same as every key before this existed, so that state renders no line at all
 * (see each page's template) rather than an empty list.
 */
export function classificationLevelNames(key, levels) {
  return key.allowedClassifications.map((id) => classificationLevelName(id, levels)).join(', ')
}
