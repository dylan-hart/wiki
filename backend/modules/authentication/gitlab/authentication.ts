import { OidcPreset } from '../oidc/preset.ts'

/**
 * GitLab
 *
 * GitLab has been an OIDC provider since 11.9, and its issuer is simply the instance's own base URL —
 * `gitlab.com` for the hosted service, or a self-hosted install's URL for everyone else. `baseUrl`
 * defaults to `https://gitlab.com` in `definition.yml` so the common case needs no admin input at
 * all, while a self-hosted instance just overwrites it.
 */
export default class GitlabAuthentication extends OidcPreset {
  constructor(strategyId: string, conf: Record<string, any>) {
    super(strategyId, conf, {
      issuer: (c) => String(c.baseUrl || 'https://gitlab.com').replace(/\/$/, '')
    })
  }
}
