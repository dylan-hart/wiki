import { OidcPreset } from '../oidc/preset.ts'

export default class GitlabAuthentication extends OidcPreset {
  constructor(strategyId: string, conf: Record<string, any>) {
    super(strategyId, conf, {
      issuer: (c) => String(c.baseUrl || 'https://gitlab.com').replace(/\/$/, '')
    })
  }
}
