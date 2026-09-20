/**
 * `dev/build/Dockerfile` installs whichever `chromium` build Debian bookworm's apt repo currently
 * serves (`PUPPETEER_SKIP_DOWNLOAD` + `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium` — see
 * `helpers/puppeteer.ts`), rather than the Chrome-for-Testing build `puppeteer` itself would
 * otherwise download. When those two drift too far apart, a CDP client built against a much older
 * protocol than the browser it drives gets its `Page.navigate` refused outright with
 * `net::ERR_INVALID_ARGUMENT` — sandbox flags or no sandbox flags.
 *
 * Nothing here can reach into a built image and ask its `chromium` binary what version it is; that
 * stays a manual check (build the image, boot it, request a PDF export). What this guards is silent
 * drift: a routine `npm run ncu` bumping `puppeteer` without anyone re-checking the pairing. Bumping
 * the pin is expected and fine — but do it deliberately:
 *
 *   npm view puppeteer-core@<candidate version> dependencies   # confirms the version resolves
 *   npm pack puppeteer-core@<candidate version> && tar xzf …   # then read lib/puppeteer/revisions.js
 *
 * compare the `chrome` field there against the `chromium` version the Dockerfile's apt install
 * resolves to, and update both constants below plus
 * `docs/decisions/2026-09-14-puppeteer-chromium-protocol-pin.md`. Jumping straight to the newest
 * puppeteer is not the safe move: it can pin a Chrome major ahead of apt's and reintroduce the same
 * skew in the other direction.
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'

const BACKEND_ROOT = path.resolve(import.meta.dirname, '..')

/**
 * The puppeteer version last confirmed to pin a Chrome-for-Testing build close to what
 * `dev/build/Dockerfile` actually installs.
 */
const EXPECTED_PUPPETEER_VERSION = '25.9.0'

/** The Chrome major version `EXPECTED_PUPPETEER_VERSION`'s `puppeteer-core` pins internally. */
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
    // puppeteer is an optionalDependency, so a worktree that never installed it genuinely has no
    // puppeteer-core to check; that is not this test's concern, so skip rather than fail.
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
