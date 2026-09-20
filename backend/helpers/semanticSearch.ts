export function semanticSearchAvailable(config: Record<string, any> | null | undefined): boolean {
  return (
    CARDINAL.capabilities?.semanticSearch === true &&
    config?.search?.config?.semanticEnabled === true
  )
}

export function semanticSearchEnabledFor(siteId: string): boolean {
  return semanticSearchAvailable(CARDINAL.sites[siteId]?.config)
}
