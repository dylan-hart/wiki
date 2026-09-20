import type { ScopeOverrides } from '../core/logger.ts'

/**
 * Flags are read live: nothing here needs a restart. Anything added to this list needs a consumer,
 * otherwise the admin area offers a switch that changes nothing.
 */
export const FLAGS = {
  /** Consumed by the frontend, which reveals unfinished features when it is on. */
  experimental: 'Unfinished features are offered in the interface.',
  /** A runtime override of the `auth` log scope, applied by `logScopeOverrides()` below. */
  authDebug:
    'Raises the `auth` log scope to debug, so login, registration and 2FA attempts are logged in detail. Takes effect on the next line; no restart needed.',
  /**
   * A runtime override of the `sql` log scope, applied by `logScopeOverrides()` below.
   * `core/db.ts`'s query logger emits unconditionally at `debug`; this is what decides whether that
   * reaches the log. Bound parameter values are redacted there — only each one's type/length is
   * logged — because a bound parameter can carry a credential.
   */
  sqlLog:
    'Raises the `sql` log scope to debug, so every database query is logged, including the type and length of each bound parameter (never its value) — bound parameters can include credentials such as the API signing key, its passphrase, or the session secret, so enable only when needed.'
} as const

export type Flag = keyof typeof FLAGS

const FLAG_KEYS = Object.keys(FLAGS) as Flag[]

/**
 * Low-level switches for debugging and for unfinished features, stored in the `flags` settings blob.
 * They are readable without authentication — the frontend needs `experimental` before anyone has
 * logged in — so a flag must never carry anything sensitive.
 */
class Flags {
  getFlags(): Record<Flag, boolean> {
    const flags = CARDINAL.config.flags ?? {}
    return Object.fromEntries(FLAG_KEYS.map((key) => [key, flags[key] === true])) as Record<
      Flag,
      boolean
    >
  }

  /**
   * Reads the config directly on every call, so flipping a flag takes effect immediately —
   * including on the other instances of a cluster, which reload their config when this one saves.
   */
  isEnabled(flag: Flag): boolean {
    return CARDINAL.config.flags?.[flag] === true
  }

  pickFlags(body: Record<string, any>): Partial<Record<Flag, boolean>> {
    const patch: Partial<Record<Flag, boolean>> = {}
    for (const key of FLAG_KEYS) {
      if (body[key] !== undefined) {
        patch[key] = body[key] === true
      }
    }
    return patch
  }

  async updateFlags(patch: Partial<Record<Flag, boolean>>): Promise<boolean> {
    const previous = CARDINAL.config.flags
    CARDINAL.config.flags = { ...previous, ...patch }

    if (!(await CARDINAL.configSvc.saveToDb(['flags']))) {
      CARDINAL.config.flags = previous
      return false
    }

    for (const [key, value] of Object.entries(patch)) {
      CARDINAL.logger.info('config', 'system flag changed', { key, enabled: Boolean(value) })
    }
    return true
  }

  /**
   * The override map `core/logger.ts` resolves a line's threshold against — `index.ts` hands
   * `logger.init()` a thunk over this, re-read on every line. Nothing is returned for a flag that
   * is off: absence means "this scope has no override", which is what lets `logScopes:` and then
   * `logLevel` answer instead.
   */
  logScopeOverrides(): ScopeOverrides {
    return {
      ...(this.isEnabled('sqlLog') ? { sql: 'debug' as const } : {}),
      ...(this.isEnabled('authDebug') ? { auth: 'debug' as const } : {})
    }
  }

  /**
   * A thin wrapper over `CARDINAL.logger.debug('auth', …)` and nothing more: the flag does not gate
   * this call, it raises the `auth` scope's threshold, so the one decision about whether the line is
   * worth emitting is made in one place.
   */
  authDebug(message: string): void {
    CARDINAL.logger.debug('auth', message)
  }
}

export const flags = new Flags()
