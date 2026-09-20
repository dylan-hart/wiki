/**
 * `dev/build/Dockerfile` installs whichever `chromium` Debian bookworm's apt repo serves
 * (`PUPPETEER_SKIP_DOWNLOAD` + `PUPPETEER_EXECUTABLE_PATH`, see `helpers/puppeteer.ts`) rather than
 * the Chrome-for-Testing build `puppeteer` would download. Drift far enough apart and a CDP client
 * built against a much older protocol than the browser it drives gets its `Page.navigate` refused
 * outright with `net::ERR_INVALID_ARGUMENT` — sandbox flags or no sandbox flags. Nothing here can
 * ask a built image's binary what version it is, so what is guarded is a routine `npm run ncu`
 * bumping `puppeteer` with nobody re-checking the pairing.
 *
 * To bump deliberately: `npm pack puppeteer-core@<candidate>` and read `lib/puppeteer/revisions.js`,
 * compare its `chrome` field against what the Dockerfile's apt install resolves to, then update both
 * constants below and `docs/decisions/2026-09-14-puppeteer-chromium-protocol-pin.md`. The newest
 * puppeteer is not automatically the safe move — it can pin a Chrome major ahead of apt's and
 * reintroduce the skew in the other direction.
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'

const BACKEND_ROOT = path.resolve(import.meta.dirname, '..')

const EXPECTED_PUPPETEER_VERSION = '25.9.0'

const EXPECTED_CHROME_MAJOR = '152'

describe('puppeteer/chromium version pairing (OpenProject #3256)', () => {
  test('backend/package.json pins the last version-checked puppeteer release', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(BACKEND_ROOT, 'package.json'), 'utf8'))
    assert.equal(
      pkg.optionalDependencies?.puppeteer,
      EXPECTED_PUPPETEER_VERSION,
      'puppeteer was bumped without re-checking its pinned Chrome-for-Testing build against the ' +
        'chromium version dev/build/Dockerfile installs — see this file’s header comment and ' +
        'docs/decisions/2026-09-14-puppeteer-chromium-protocol-pin.md'
    )
  })

  test('installed puppeteer-core (when present) still pins the expected Chrome major version', async (t) => {
    // puppeteer is an optionalDependency: a worktree that never installed it has nothing to check,
    // which is not this test's concern.
    let revisions: { chrome: string }
    try {
      ;({ PUPPETEER_REVISIONS: revisions } =
        await import('puppeteer-core/lib/puppeteer/revisions.js'))
    } catch {
      t.skip('puppeteer-core is not installed in this environment')
      return
    }

    const chromeMajor = revisions.chrome.split('.')[0]
    assert.equal(
      chromeMajor,
      EXPECTED_CHROME_MAJOR,
      `installed puppeteer-core pins Chrome ${revisions.chrome}, whose major version no longer ` +
        `matches the ${EXPECTED_CHROME_MAJOR}.x this pairing was last verified against`
    )
  })
})
