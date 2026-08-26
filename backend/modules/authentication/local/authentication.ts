/* global WIKI */
import bcrypt from 'bcryptjs'

// ------------------------------------
// Local Account
// ------------------------------------
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
    if (user) {
      const authStrategyData = (user.auth as Record<string, any>)[this.strategyId]
      if (!authStrategyData) {
        throw new Error('ERR_INVALID_STRATEGY')
      } else if ((await bcrypt.compare(password, authStrategyData.password)) !== true) {
        throw new Error('ERR_LOGIN_FAILED')
      } else if (authStrategyData.restrictLogin) {
        // -> `isActive`/`isVerified` are checked centrally by `models/users.ts#afterLoginChecks()`,
        //    which every login path (this one included) ends in. `restrictLogin` is a per-strategy
        //    flag with no other enforcement point, so it stays checked here.
        throw new Error('ERR_LOGIN_RESTRICTED')
      } else {
        return user
      }
    } else {
      throw new Error('ERR_LOGIN_FAILED')
    }
  }
}
