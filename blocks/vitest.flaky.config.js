import { configDefaults } from 'vitest/config'
import baseConfig, { FLAKY_INCLUDE } from './vitest.config.js'

/*
  The quarantine lane -- `npm run test:flaky`. See `docs/decisions/flaky-test-quarantine.md` for
  what belongs in it, what does not, and why every file in it carries a dated expiry.

  A separate config rather than a command-line flag, because Vitest's CLI has no `--include` and its
  `--exclude` is ADDITIVE -- there is no way from the command line to cancel the base config's
  exclusion of `FLAKY_GLOB` and select the lane instead. Everything else (the jsdom environment,
  `test/setup.js`) comes from `vitest.config.js` unchanged, so a lane test runs in exactly the
  environment it would have run in before it was quarantined.

  `passWithNoTests` because the lane is legitimately empty in this workspace as of writing: an empty
  quarantine is the goal state, not a misconfiguration, and CI's report-only step for it (Task #2692)
  must not go red for it.
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
