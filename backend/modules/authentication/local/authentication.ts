/* global WIKI */
import bcrypt from 'bcryptjs'

// ------------------------------------
// Local Account
// ------------------------------------

/**
 * A fixed, valid bcrypt hash with no known plaintext, compared against whenever there is no real
 * password hash to check against (no matching user, or a matched user with no local-strategy data).
 * This keeps the no-user and no-strategy-data branches paying the same bcrypt.compare cost as the
 * real-password branch below, so an unauthenticated caller cannot use response timing to learn
 * whether an address exists or is linked to this strategy. See work package 2141.
 */
const DUMMY_PASSWORD_HASH = '$2a$12$CwTycUXWue0Thq9StjUM0uJ8jJKQmT.YQxN.z9bKmHK1P.9YHc1Yq'

export default class LocalAuthentication {
  strategyId: string
  conf: Record<string, any>
  /** Set by models/authentication.ts right after construction. */
  module?: string

  constructor(strategyId: string, conf: Record<string, any>) {
    this.strategyId = strategyId
    this.conf = conf
  }

  async authenticate({ username, password }: { username: string; password: string }): Promise<any> {
    const user = await WIKI.models.users.getByEmail(username.toLowerCase())
    const authStrategyData = user ? (user.auth as Record<string, any>)[this.strategyId] : undefined
    if (!authStrategyData) {
      await bcrypt.compare(password, DUMMY_PASSWORD_HASH)
      throw new Error('ERR_LOGIN_FAILED')
    } else if ((await bcrypt.compare(password, authStrategyData.password)) !== true) {
      throw new Error('ERR_LOGIN_FAILED')
    } else if (!user.isActive) {
      throw new Error('ERR_INACTIVE_USER')
    } else if (authStrategyData.restrictLogin) {
      throw new Error('ERR_LOGIN_RESTRICTED')
    } else if (!user.isVerified) {
      throw new Error('ERR_USER_NOT_VERIFIED')
    } else {
      return user
    }
  }
}
