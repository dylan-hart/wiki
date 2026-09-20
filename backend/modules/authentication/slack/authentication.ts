import { OidcPreset } from '../oidc/preset.ts'
import { fillNameHalves } from '../../../helpers/personName.ts'
import type { AuthFlowCallback, ProviderProfile } from '../../../models/authentication.ts'

/**
 * The one thing a generic OIDC config cannot express is Slack's optional workspace restriction: a
 * `team` parameter on the authorization request that confines authentication to one workspace. Slack
 * enforces it during the authorization step itself, so — unlike Discord's guild check — it needs no
 * second authenticated API call and rides entirely on `extraAuthParams`' conditional function form.
 */
export default class SlackAuthentication extends OidcPreset {
  constructor(strategyId: string, conf: Record<string, any>) {
    super(strategyId, conf, {
      issuer: () => 'https://slack.com',
      scopes: 'openid email profile',
      extraAuthParams: (c) => (c.teamId ? { team: c.teamId } : undefined)
    })
  }

  /**
   * A naive split of the display name, for a userinfo response carrying no `given_name`/`family_name`
   * — `fillNameHalves` fills only what the shared OIDC mapping left unset, so a real claim always
   * wins. It stays on this preset rather than `oidc/preset.ts`, where it would pre-empt the real name
   * claims every other preset reads.
   */
  override async profile(flow: AuthFlowCallback): Promise<ProviderProfile> {
    const profile = await super.profile(flow)
    return { ...profile, ...fillNameHalves(profile.name, profile) }
  }
}
