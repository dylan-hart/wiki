export const DUPLICATED_PAGE_PROPS = [
  'description',
  'icon',
  'tags',
  'relations',
  'classification',
  'publishState',
  'publishStartDate',
  'publishEndDate',
  'isBrowsable',
  'isSearchable',
  'allowComments',
  'allowContributions',
  'showSidebar',
  'showTags',
  'showToc',
  'tocDepth'
]

export function duplicatedPageProps(source) {
  const props = {}
  for (const key of DUPLICATED_PAGE_PROPS) {
    const value = source?.[key]
    if (value !== undefined && value !== null) {
      props[key] = value
    }
  }
  if (props.publishState !== 'scheduled') {
    delete props.publishStartDate
    delete props.publishEndDate
  }
  return props
}
