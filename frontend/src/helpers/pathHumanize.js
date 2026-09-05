import {
  camelCase,
  camelCaseTransform,
  lowerCase,
  pascalCase,
  pascalCaseTransform,
  titleCase,
  upperCase
} from 'text-case'

/**
 * Case styles `humanizePathSegment` understands. Mirrors the 5 styles the parent Feature's admin
 * "path display" setting offers (site:general → #2577 owns the actual setting key/enum) — this
 * list is this helper's own contract, not a re-read of that setting's stored value, so a caller
 * translates the setting into one of these before calling in.
 */
export const PATH_CASE_STYLES = ['lower', 'upper', 'camelCase', 'pascalCase', 'titleCase']

/**
 * Standard English "minor words" a proper Title Case leaves lowercase unless they open or close
 * the phrase (articles, coordinating conjunctions, short prepositions). This is a generic,
 * widely-used convention — not a copy of `text-case`'s own list, which is internal to its
 * `text-title-case` package and not part of its public API, so it can't be reused directly as the
 * non-acronym fallback our `transform` hook needs.
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
 * Look up a word's canonical acronym casing, case-insensitively.
 *
 * `acronymMap` is a lowercase-key → canonical-casing lookup — the shape the Glossary's acronym
 * list (#2575) is expected to expose to the frontend. Both a `Map` and a plain object are
 * accepted, since a caller may hold either depending on how it assembled the map from the API
 * response; `null`/`undefined` (no acronyms configured, or the caller hasn't loaded them yet) is
 * treated as an empty map rather than thrown on.
 *
 * @returns The canonical casing, or `undefined` if `word` isn't a known acronym.
 */
function acronymCasing(word, acronymMap) {
  if (!acronymMap) {
    return undefined
  }
  const key = word.toLowerCase()
  return acronymMap instanceof Map ? acronymMap.get(key) : acronymMap[key]
}

/**
 * Title Case's per-word fallback for a non-acronym word: capitalized, except a minor word kept
 * lowercase unless it opens or closes the segment. Mirrors the standard English title-case
 * convention `text-case`'s own (unexported) default follows — see `TITLE_CASE_MINOR_WORDS` above.
 */
function titleCaseFallback(word, index, parts) {
  const lower = word.toLowerCase()
  if (index !== 0 && index !== parts.length - 1 && TITLE_CASE_MINOR_WORDS.has(lower)) {
    return lower
  }
  return lower.charAt(0).toUpperCase() + lower.slice(1)
}

/**
 * Build the `transform` callback a word-aware `text-case` function (`camelCase`/`pascalCase`/
 * `titleCase`) is given: an acronym match wins verbatim over the style's own casing, in any
 * position — first, middle or last word alike — exactly as the parent Feature's acronym-override
 * design calls for; a miss defers to that style's own default per-word rule.
 */
function acronymAwareTransform(acronymMap, fallback) {
  return (word, index, parts) => acronymCasing(word, acronymMap) ?? fallback(word, index, parts)
}

/**
 * Turn a raw, lowercase tree path segment (as `models/tree.ts`'s `rePathName` stores it — the
 * segment is always `/^[a-z0-9-]+$/`, so `-` is the only separator ever seen within one) into a
 * displayed label under a chosen case style, honoring the Glossary's acronym list for casing
 * overrides.
 *
 * Pure and synchronous by design (see parent Feature #2574 / this Task's own coordination note):
 * fetching the site's case-style setting and the acronym list is the caller's job, at whichever
 * render site (#2578) needs a label — this helper only ever transforms the two values it's given.
 *
 * @param segment A single raw path segment, e.g. `"uss"`, `"getting-started"`. Falsy input is
 *   returned unchanged.
 * @param caseStyle One of `PATH_CASE_STYLES`. An unrecognized value falls back to `'lower'` — the
 *   same "no visible change from the raw segment" behavior a caller that hasn't wired the site
 *   setting yet already gets.
 * @param acronymMap A lowercase-key → canonical-casing lookup (`Map` or plain object), or
 *   `null`/`undefined` for none.
 * @returns The humanized label.
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
      return words.map((word) => acronymCasing(word, acronymMap) ?? upperCase(word)).join('-')
    case 'camelCase':
      return camelCase(words.join('-'), {
        transform: acronymAwareTransform(acronymMap, camelCaseTransform)
      })
    case 'pascalCase':
      return pascalCase(words.join('-'), {
        transform: acronymAwareTransform(acronymMap, pascalCaseTransform)
      })
    case 'titleCase':
      return titleCase(words.join('-'), {
        transform: acronymAwareTransform(acronymMap, titleCaseFallback)
      })
    case 'lower':
    default:
      return words.map((word) => acronymCasing(word, acronymMap) ?? lowerCase(word)).join('-')
  }
}
