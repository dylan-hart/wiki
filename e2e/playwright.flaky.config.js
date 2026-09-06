import { globSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import baseConfig, { FLAKY_GLOB } from './playwright.config.js'

/**
 * The quarantine lane -- `npm run test:flaky`. See `docs/decisions/flaky-test-quarantine.md` for
 * what belongs in it, what does not, and why every file in it carries a dated expiry.
 *
 * A separate config rather than a command-line flag, because Playwright's CLI has no
 * `--test-match`: a positional filter would still be filtered a second time by the base config's
 * `testIgnore`, which is precisely the exclusion that has to be cancelled here. Everything else --
 * the `DATABASE_URL` precondition, the `webServer` boot, the pinned viewport -- comes from
 * `playwright.config.js` unchanged, so a lane spec runs against exactly the stack it would have run
 * against before it was quarantined.
 */

/**
 * Whether this workspace has any quarantined spec at all. Playwright starts `webServer` BEFORE it
 * discovers tests, so an empty lane would otherwise boot a whole backend against a real database to
 * then report zero specs -- verified, not assumed. There is nothing for a server to serve when the
 * lane is empty, so it is dropped in that case; `npm run test:flaky` then reports "0 tests" and (with
 * `--pass-with-no-tests`) exits 0 without touching Postgres. The moment a `*.flaky.spec.js` lands,
 * the real `webServer` comes back with it.
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
