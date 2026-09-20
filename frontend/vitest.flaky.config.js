import { configDefaults } from 'vitest/config'
import baseConfig, { FLAKY_INCLUDE } from './vitest.config.js'

/*
  The quarantine lane -- `npm run test:flaky`. Every file in it carries a dated expiry.

  A separate config rather than a command-line flag, because Vitest's CLI has no `--include` and its
  `--exclude` is ADDITIVE -- nothing on the command line can cancel the base config's exclusion of
  `FLAKY_GLOB` and select the lane instead.

  `passWithNoTests` because an empty quarantine is the goal state, not a misconfiguration, and CI's
  report-only step for the lane must not go red for it.
*/
export default {
  ...baseConfig,
  test: {
    ...baseConfig.test,
    include: FLAKY_INCLUDE,
    exclude: [...configDefaults.exclude],
    passWithNoTests: true
  }
}
