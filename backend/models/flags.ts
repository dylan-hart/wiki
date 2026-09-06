import type { ScopeOverrides } from '../core/logger.ts'

/**
 * The system flags, and what enabling each one actually does.
 *
 * Flags are read live: nothing here needs a restart, and every one of them has an effect somewhere in
 * the running server. Anything added to this list needs a consumer, otherwise the admin area offers a
 * switch that changes nothing.
 */
export const FLAGS = {
  /** Consumed by the frontend, which reveals unfinished features when it is on. */
  experimental: 'Unfinished features are offered in the interface.',
  /**
   * A runtime override of the `auth` log scope, applied by `logScopeOverrides()` below and consumed
   * by `core/logger.ts` on every line — see `authDebug()`.
   */
  authDebug:
    'Raises the `auth` log scope to debug, so login, registration and 2FA attempts are logged in detail. Takes effect on the next line; no restart needed.',
  /**
   * A runtime override of the `sql` log scope, applied by `logScopeOverrides()` below and consumed
   * by `core/logger.ts` on every line. `core/db.ts`'s query logger emits unconditionally at `debug`;
   * this is what decides whether that reaches the log. Bound parameter values are redacted there —
   * only each one's type/length is logged — because a bound parameter can carry a credential (the
   * API signing key and its passphrase, the session secret, SMTP/LDAP/OAuth secrets, ...). See
   * #2205.
   */
  sqlLog:
    'Raises the `sql` log scope to debug, so every database query is logged, including the type and length of each bound parameter (never its value) — bound parameters can include credentials such as the API signing key, its passphrase, or the session secret, so enable only when needed.'
} as const

export type Flag = keyof typeof FLAGS

const FLAG_KEYS = Object.keys(FLAGS) as Flag[]

/**
 * Flags model
 *
 * Low-level switches for debugging and for unfinished features, stored in the `flags` settings blob.
 * They are readable without authentication — the frontend needs `experimental` before anyone has
 * logged in — so a flag must never carry anything sensitive.
 */
class Flags {
  /**
   * Every flag, with anything missing from the stored blob reported as off
   */
  getFlags(): Record<Flag, boolean> {
    const flags = WIKI.config.flags ?? {}
    return Object.fromEntries(FLAG_KEYS.map((key) => [key, flags[key] === true])) as Record<
      Flag,
      boolean
    >
  }

  /**
   * Whether a single flag is on.
   *
   * Reads the config directly on every call, so flipping a flag takes effect immediately — including
   * on the other instances of a cluster, which reload their config when this one saves.
   */
  isEnabled(flag: Flag): boolean {
    return WIKI.config.flags?.[flag] === true
  }

  /**
   * Keep only the flags this model owns, dropping anything else a client sends
   */
  pickFlags(body: Record<string, any>): Partial<Record<Flag, boolean>> {
    const patch: Partial<Record<Flag, boolean>> = {}
    for (const key of FLAG_KEYS) {
      if (body[key] !== undefined) {
        patch[key] = body[key] === true
      }
    }
    return patch
  }

  /**
   * Save a patch of flags, leaving the ones it does not mention alone
   *
   * @returns Whether the flags were saved
   */
  async updateFlags(patch: Partial<Record<Flag, boolean>>): Promise<boolean> {
    const previous = WIKI.config.flags
    WIKI.config.flags = { ...previous, ...patch }

    if (!(await WIKI.configSvc.saveToDb(['flags']))) {
      WIKI.config.flags = previous
      return false
    }

    for (const [key, value] of Object.entries(patch)) {
      WIKI.logger.info('config', 'system flag changed', { key, enabled: Boolean(value) })
    }
    return true
  }

  /**
   * The two log-scope flags, as the override map `core/logger.ts` resolves a line's threshold
   * against — `index.ts` hands `logger.init()` a thunk over this, re-read on every line.
   *
   * Read off `WIKI.config.flags` like every other flag, so flipping one in the admin area takes
   * effect on the next line across the whole cluster with no restart. Nothing is returned for a
   * flag that is off: absence means "this scope has no override", which is what lets `logScopes:`
   * and then `logLevel` answer instead.
   */
  logScopeOverrides(): ScopeOverrides {
    return {
      ...(this.isEnabled('sqlLog') ? { sql: 'debug' as const } : {}),
      ...(this.isEnabled('authDebug') ? { auth: 'debug' as const } : {})
    }
  }

  /**
   * Log an authentication detail.
   *
   * A thin wrapper over `WIKI.logger.debug('auth', …)` and nothing more: the flag no longer gates
   * the call here, it raises the `auth` scope's threshold (see `logScopeOverrides()` above), so the
   * one decision about whether this line is worth emitting is made in one place. `debug` is the
   * honest level for a per-attempt line — before per-scope thresholds existed it had to be `info`
   * to clear the default floor, which is exactly the conflation #2663 removed.
   */
  authDebug(message: string): void {
    WIKI.logger.debug('auth', message)
  }
}

export const flags = new Flags()
