/* global CARDINAL */
import bcrypt from 'bcryptjs'

/**
 * Compared against whenever there is no real hash to compare against — an unknown email, or one
 * linked to a different strategy — so every branch of `authenticate()` pays for exactly one
 * `bcrypt.compare` at the cost factor real logins use. Without it, response time tells an
 * unauthenticated caller which addresses have local accounts.
 */
const DUMMY_HASH = bcrypt.hashSync('wiki-js-constant-time-dummy-password', 12)

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
    const user = await CARDINAL.models.users.getByEmail(username.toLowerCase())
    const authStrategyData = user
      ? ((user.auth as Record<string, any>)[this.strategyId] ?? null)
      : null
    const passwordMatches = await bcrypt.compare(password, authStrategyData?.password ?? DUMMY_HASH)

    if (!user || !authStrategyData || passwordMatches !== true) {
      CARDINAL.models.flags.authDebug(
        `Local strategy ${this.strategyId} refused the login: ${
          !user
            ? 'no account for that address'
            : !authStrategyData
              ? `account ${user.id} is not linked to strategy ${this.strategyId}`
              : `wrong password for account ${user.id}`
        }`
      )
      // -> One error for all three cases: telling "no such account" from "account exists but isn't
      //    linked to this strategy" is a one-request oracle for which emails have accounts.
      throw new Error('ERR_LOGIN_FAILED')
    } else if (authStrategyData.restrictLogin) {
      // -> `isActive`/`isVerified` are checked centrally by `models/users.ts#afterLoginChecks()`,
      //    which every login path ends in; `restrictLogin` has no other enforcement point.
      throw new Error('ERR_LOGIN_RESTRICTED')
    } else {
      return user
    }
  }
}
