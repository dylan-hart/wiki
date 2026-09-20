export const SEARCH_FILTER_MODES = ['include', 'exclude'] as const
export const SEARCH_FILTER_TYPES = ['path', 'tag', 'locale', 'editor', 'publishState'] as const
export const SEARCH_FILTER_PUBLISH_STATES = ['draft', 'published', 'scheduled'] as const
export const SEARCH_FILTERS_MAX_ROWS = 20
export const SEARCH_FILTER_VALUE_MAX_LENGTH = 512

export type SearchFilterMode = (typeof SEARCH_FILTER_MODES)[number]
export type SearchFilterType = (typeof SEARCH_FILTER_TYPES)[number]

export interface SearchFilter {
  mode: SearchFilterMode
  type: SearchFilterType
  value: string
}

export function isSearchFilter(row: unknown): row is SearchFilter {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) {
    return false
  }
  const { mode, type, value } = row as Record<string, unknown>
  if (!(SEARCH_FILTER_MODES as readonly unknown[]).includes(mode)) {
    return false
  }
  if (!(SEARCH_FILTER_TYPES as readonly unknown[]).includes(type)) {
    return false
  }
  if (typeof value !== 'string' || value.length < 1) {
    return false
  }
  if (value.length > SEARCH_FILTER_VALUE_MAX_LENGTH) {
    return false
  }
  if (type === 'publishState') {
    return (SEARCH_FILTER_PUBLISH_STATES as readonly string[]).includes(value)
  }
  return true
}

export function isSearchFilters(rows: unknown): rows is SearchFilter[] {
  return Array.isArray(rows) && rows.length <= SEARCH_FILTERS_MAX_ROWS && rows.every(isSearchFilter)
}

export function normalizeSearchFilters(rows: SearchFilter[]): SearchFilter[] {
  return rows.map(({ mode, type, value }) => ({ mode, type, value }))
}
