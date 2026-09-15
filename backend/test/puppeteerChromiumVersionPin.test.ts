/**
 * Regression coverage for OpenProject #3256 ("PDF export fails with net::ERR_INVALID_ARGUMENT even
 * with allowPuppeteerNoSandbox:true (puppeteer 25.4.0 vs. system chromium 152 in
 * dev/build/Dockerfile)").
 *
 * `dev/build/Dockerfile` installs whichever `chromium` build Debian bookworm's apt repo currently
 * serves (`PUPPETEER_SKIP_DOWNLOAD` + `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium` — see
 * `helpers/puppeteer.ts`), rather than the Chrome-for-Testing build `puppeteer` itself would
 * otherwise download. Those two versions drifting too far apart is exactly what #3256 found: a CDP
 * client built against a much older protocol than the browser it drives can get its `Page.navigate`
 * refused outright with `net::ERR_INVALID_ARGUMENT`, even once the (unrelated) sandbox problem
 * tracked by #3214 is worked around.
 *
 * `docs/decisions/2026-09-14-puppeteer-chromium-protocol-pin.md` records the full investigation:
 * `puppeteer@25.4.0` pinned Chrome `151.0.7922.47` against a system Chromium that had already moved
 * to `152.0.7977.75`; `puppeteer@25.9.0` pins `152.0.7977.54`, in the same `152.0.7977.x` build train
 * and the closest match available on the registry at the time this was fixed — closer than jumping to
 * the newest release (`25.11.0` pins Chrome `153.x`, which would just reintroduce the same class of
 * skew in the other direction against today's apt-installed `152.x`).
 *
 * This test does not — cannot, from this sandbox — reach into a built `dev/build/Dockerfile` image
 * and ask its `chromium` binary what version it actually is; that verification is a manual repeat of
 * #3256's own repro (build the image, boot it, request a PDF export). What this test guards against
 * is silent drift: a routine `npm run ncu` bumping `puppeteer` (or `puppeteer-core`) without anyone
 * re-checking that pairing. Bumping the pinned version here is expected and fine — but do it
 * deliberately, by re-running the check below and updating both this assertion and the decision doc:
 *
 *   npm view puppeteer-core@<candidate version> dependencies   # confirms the version resolves
 *   npm pack puppeteer-core@<candidate version> && tar xzf …   # then read lib/puppeteer/revisions.js
 *
 * and compare the `chrome` field there against the `chromium` version `dev/build/Dockerfile`'s apt
 * install currently resolves to (see the decision doc for how that was captured for this pass).
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'

const BACKEND_ROOT = path.resolve(import.meta.dirname, '..')

/**
 * The puppeteer version last confirmed (via the registry-metadata investigation in the decision doc)
 * to pin a Chrome-for-Testing build close to what `dev/build/Dockerfile` actually installs. Bumping
 * `backend/package.json`'s `puppeteer` without updating this constant is exactly the silent drift
 * this test exists to catch.
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
    // puppeteer is an optionalDependency (backend/CLAUDE.md's Puppeteer availability convention) — a
    // worktree that never ran `npm install`/`npm ci` genuinely has no node_modules/puppeteer-core to
    // check, and that is not this test's concern; skip rather than fail.
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
