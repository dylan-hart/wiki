import { globSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import baseConfig, { FLAKY_GLOB } from './playwright.config.js'

/**
 * The quarantine lane -- `npm run test:flaky`. Every file in it carries a dated expiry.
 *
 * A separate config rather than a CLI flag, because Playwright has no `--test-match`: a positional
 * filter would still be filtered a second time by the base config's `testIgnore`, which is
 * precisely the exclusion that has to be cancelled here. Everything else comes from
 * `playwright.config.js` unchanged, so a lane spec runs against the same stack it ran against
 * before it was quarantined.
 */

/**
 * Playwright starts `webServer` BEFORE it discovers tests, so an empty lane would otherwise boot a
 * whole backend against a real database only to report zero specs. Dropping it in that case lets
 * `npm run test:flaky` exit 0 (with `--pass-with-no-tests`) without touching Postgres.
 */
const laneSpecs = globSync(FLAKY_GLOB, {
  cwd: fileURLToPath(new URL('./tests', import.meta.url))
})

export default {
  ...baseConfig,
  testMatch: FLAKY_GLOB,
  testIgnore: undefined,
  webServer: laneSpecs.length > 0 ? baseConfig.webServer : undefined
}
