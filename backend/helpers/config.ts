const isoDurationReg =
  /^(-|\+)?P(?:([-+]?[0-9,.]*)Y)?(?:([-+]?[0-9,.]*)M)?(?:([-+]?[0-9,.]*)W)?(?:([-+]?[0-9,.]*)D)?(?:T(?:([-+]?[0-9,.]*)H)?(?:([-+]?[0-9,.]*)M)?(?:([-+]?[0-9,.]*)S)?)?$/

export default {
  /**
   * Replaces `$(ENV_VAR)` with that environment variable's value, and `$(ENV_VAR:default)` with the
   * default when it is unset or empty. The default capture is lazy so that two references on one
   * line each stop at their own closing paren.
   */
  parseConfigValue(cfg: string): string {
    return cfg.replaceAll(/\$\(([A-Z0-9_]+)(?::(.+?))?\)/g, (fm: string, m: string, d: string) => {
      return process.env[m] || d
    })
  },

  isValidDurationString(val: string): boolean {
    return isoDurationReg.test(val)
  }
}
