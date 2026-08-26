/* global WIKI */
import bcrypt from 'bcryptjs'

// ------------------------------------
// Local Account
// ------------------------------------

/**
 * A bcrypt hash of a fixed, unguessable dummy password, computed once at module load and compared
 * against whenever there is no real password hash to compare against (an unknown email, or one
 * linked to a different strategy). Every branch of `authenticate()` then pays for exactly one
 * `bcrypt.compare` at the same cost factor real logins use, so neither response time nor response
 * shape lets an unauthenticated caller tell "no such account" apart from "account exists but has no
 * local password" apart from "account exists, wrong password" -- all three now answer the same
 * `ERR_LOGIN_FAILED` in roughly the same time.
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
    const user = await WIKI.models.users.getByEmail(username.toLowerCase())
    const authStrategyData = user
      ? ((user.auth as Record<string, any>)[this.strategyId] ?? null)
      : null
    // -> Compared unconditionally, even when there is no real hash to compare against, so this
    //    branch costs the same as a genuine wrong-password rejection -- see DUMMY_HASH above.
    const passwordMatches = await bcrypt.compare(password, authStrategyData?.password ?? DUMMY_HASH)

    if (!user || !authStrategyData || passwordMatches !== true) {
      // -> Collapsed from separate ERR_LOGIN_FAILED / ERR_INVALID_STRATEGY outcomes: distinguishing
      //    "no such account" from "account exists but isn't linked to this strategy" is not worth
      //    handing an unauthenticated caller a one-request oracle for which emails have accounts.
      throw new Error('ERR_LOGIN_FAILED')
    } else if (authStrategyData.restrictLogin) {
      // -> `isActive`/`isVerified` are checked centrally by `models/users.ts#afterLoginChecks()`,
      //    which every login path (this one included) ends in. `restrictLogin` is a per-strategy
      //    flag with no other enforcement point, so it stays checked here.
      throw new Error('ERR_LOGIN_RESTRICTED')
    } else {
      return user
    }
  }
}
