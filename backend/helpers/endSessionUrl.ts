export interface EndSessionParams {
  idTokenHint?: string
  postLogoutRedirectUri?: string
}

export function buildEndSessionUrl(
  logoutURL: unknown,
  { idTokenHint, postLogoutRedirectUri }: EndSessionParams = {}
): string | null {
  if (typeof logoutURL !== 'string' || !logoutURL.trim()) {
    return null
  }
  let url: URL
  try {
    url = new URL(logoutURL.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return null
  }
  if (idTokenHint) {
    url.searchParams.append('id_token_hint', idTokenHint)
  }
  if (postLogoutRedirectUri) {
    url.searchParams.append('post_logout_redirect_uri', postLogoutRedirectUri)
  }
  return url.toString()
}
