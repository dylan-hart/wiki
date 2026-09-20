/**
 * This helper's own contract, not a re-read of the admin "path display" setting's stored value: a
 * caller translates that setting into one of these before calling in.
 */
export const PATH_CASE_STYLES = ['lower', 'upper', 'camelCase', 'pascalCase', 'titleCase']

/**
 * Standard English "minor words" a proper Title Case leaves lowercase unless they open or close
 * the phrase (articles, coordinating conjunctions, short prepositions).
 */
const TITLE_CASE_MINOR_WORDS = new Set([
  'a',
  'an',
  'and',
  'at',
  'but',
  'by',
  'en',
  'for',
  'if',
  'in',
  'nor',
  'of',
  'on',
  'or',
  'per',
  'so',
  'the',
  'to',
  'up',
  'via',
  'yet'
])

/**
 * `acronymMap` is the Glossary's lowercase-key → canonical-casing lookup, accepted as either a
 * `Map` or a plain object since a caller may hold either depending on how it assembled it from the
 * API response.
 */
function acronymCasing(word, acronymMap) {
  if (!acronymMap) {
    return undefined
  }
  const key = word.toLowerCase()
  return acronymMap instanceof Map ? acronymMap.get(key) : acronymMap[key]
}

/**
 * A word starting with a digit, other than the segment's first, is prefixed with `_` rather than
 * capitalized: a bare digit has no case to change, and the `_` keeps it from visually fusing with
 * the previous word once the hyphen delimiter is dropped (`release-2-notes` → `release_2Notes`,
 * never `release2Notes`).
 */
function pascalCaseTransform(word, index) {
  const firstChar = word.charAt(0)
  const rest = word.slice(1).toLowerCase()
  if (index > 0 && firstChar >= '0' && firstChar <= '9') {
    return `_${firstChar}${rest}`
  }
  return firstChar.toUpperCase() + rest
}

function camelCaseTransform(word, index) {
  if (index === 0) {
    return word.toLowerCase()
  }
  return pascalCaseTransform(word, index)
}

function titleCaseFallback(word, index, parts) {
  const lower = word.toLowerCase()
  if (index !== 0 && index !== parts.length - 1 && TITLE_CASE_MINOR_WORDS.has(lower)) {
    return lower
  }
  return lower.charAt(0).toUpperCase() + lower.slice(1)
}

function acronymAwareTransform(acronymMap, fallback) {
  return (word, index, parts) => acronymCasing(word, acronymMap) ?? fallback(word, index, parts)
}

/**
 * A raw tree path segment is always `/^[a-z0-9-]+$/` (`models/tree.ts`'s `rePathName`), so `-` is
 * the only separator ever seen within one.
 *
 * Fetching the site's case-style setting and the acronym list is the caller's job, at whichever
 * render site needs a label — this helper only transforms the values it is given.
 */
export function humanizePathSegment(segment, caseStyle, acronymMap) {
  if (!segment) {
    return segment
  }
  const words = segment.split('-').filter(Boolean)
  if (!words.length) {
    return segment
  }

  switch (caseStyle) {
    case 'upper':
      return words.map((word) => acronymCasing(word, acronymMap) ?? word.toUpperCase()).join('-')
    case 'camelCase':
      return words.map(acronymAwareTransform(acronymMap, camelCaseTransform)).join('')
    case 'pascalCase':
      return words.map(acronymAwareTransform(acronymMap, pascalCaseTransform)).join('')
    case 'titleCase':
      return words.map(acronymAwareTransform(acronymMap, titleCaseFallback)).join(' ')
    case 'lower':
    default:
      return words.map((word) => acronymCasing(word, acronymMap) ?? word.toLowerCase()).join('-')
  }
}
