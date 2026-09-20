export const SEARCH_FILTER_MODES = ['include', 'exclude']
export const SEARCH_FILTER_TYPES = ['path', 'tag', 'locale', 'editor', 'publishState']
export const SEARCH_FILTER_PUBLISH_STATES = ['draft', 'published', 'scheduled']
export const SEARCH_FILTER_EDITORS = ['asciidoc', 'markdown', 'wysiwyg']
export const SEARCH_FILTERS_MAX_ROWS = 20
export const SEARCH_FILTER_VALUE_MAX_LENGTH = 512

const PARAM_NAMES = {
  path: { include: 'path', exclude: 'excludePath' },
  tag: { include: 'tags', exclude: 'excludeTags' },
  locale: { include: 'locales', exclude: 'excludeLocales' },
  editor: { include: 'editor', exclude: 'excludeEditor' },
  publishState: { include: 'publishState', exclude: 'excludePublishState' }
}

export function isFreeTextFilterType(type) {
  return type === 'path' || type === 'tag'
}

export function defaultFilterValue(type, localeCodes = []) {
  if (type === 'locale') {
    return localeCodes.length === 1 ? localeCodes[0] : ''
  }
  if (type === 'publishState') {
    return 'published'
  }
  return ''
}

export function newFilterRow(localeCodes = []) {
  return { mode: 'include', type: 'path', value: defaultFilterValue('path', localeCodes) }
}

function normalizedValue(row) {
  const value = typeof row?.value === 'string' ? row.value.trim() : ''
  return row?.type === 'path' ? value.replace(/^\/+/, '') : value
}

function isApplicable(row) {
  if (!SEARCH_FILTER_MODES.includes(row?.mode) || !SEARCH_FILTER_TYPES.includes(row?.type)) {
    return false
  }
  const value = normalizedValue(row)
  if (value.length < 1 || value.length > SEARCH_FILTER_VALUE_MAX_LENGTH) {
    return false
  }
  return row.type !== 'publishState' || SEARCH_FILTER_PUBLISH_STATES.includes(value)
}

export function appliedFilters(rows) {
  return (rows ?? [])
    .filter(isApplicable)
    .map((row) => ({ mode: row.mode, type: row.type, value: normalizedValue(row) }))
}

export function filtersToSearchParams(rows, { queryTags = [] } = {}) {
  const pairs = []
  const seen = new Set()
  const add = (name, value) => {
    const key = `${name}\u0000${value}`
    if (!seen.has(key)) {
      seen.add(key)
      pairs.push([name, value])
    }
  }
  for (const { mode, type, value } of appliedFilters(rows)) {
    add(PARAM_NAMES[type][mode], value)
  }
  for (const tag of queryTags) {
    add(PARAM_NAMES.tag.include, tag)
  }
  return pairs
}

export function hasIncludeFilter(rows) {
  return appliedFilters(rows).some((row) => row.mode === 'include')
}

export function toSavedFilters(rows) {
  return appliedFilters(rows).slice(0, SEARCH_FILTERS_MAX_ROWS)
}

export function restoreFilters(saved) {
  if (!Array.isArray(saved)) {
    return []
  }
  return appliedFilters(saved).slice(0, SEARCH_FILTERS_MAX_ROWS)
}
