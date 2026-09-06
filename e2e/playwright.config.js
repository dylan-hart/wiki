import { defineConfig, devices } from '@playwright/test'

/**
 * Port the backend listens on for this run. Defaults to :3000 -- "backend on :3000 serving the
 * built frontend from `assets/`" is the task spec's literal boot shape, and CI provisions a clean
 * environment where that port is free. `E2E_PORT` exists purely as a local escape hatch for a
 * developer machine where something else already holds :3000 (a running dev instance, another
 * service) -- overridden here, not in `config.e2e.yml`, so the on-disk default stays the one the
 * spec describes.
 */
const PORT = process.env.E2E_PORT || 3000
const BASE_URL = `http://localhost:${PORT}`

/**
 * The one thing this config cannot sensibly default: which database the backend seeds itself
 * against. Failing here, before Playwright ever spawns the webServer, turns a missing
 * `DATABASE_URL` into one readable line instead of the 60s `webServer` boot timeout it would
 * otherwise surface as -- "fails meaningfully, not just a timeout" per the task's own bar.
 */
if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL is not set. The e2e suite boots a real backend against a real Postgres ' +
      'database and relies on its first-run seeding for the admin login and default site -- ' +
      'point it at an empty database, e.g.:\n\n' +
      '  docker run --rm -d --name wiki-e2e-db -p 56002:5432 \\\n' +
      '    -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=postgres postgres:18\n' +
      '  DATABASE_URL=postgres://postgres:postgres@127.0.0.1:56002/postgres npm test\n\n' +
      'In CI, a fresh `postgres:18` service container per run is what makes "seeded test ' +
      'database" true on every invocation -- see CLAUDE.md\'s "Testing (e2e)" section.'
  )
}

/**
 * The admin password every spec logs in with. Set (not left to the seeder's own `12345678`
 * default) so `ADMIN_PASS` is defined at seed time -- see `models/users.ts`'s `init()`: an unset
 * `ADMIN_PASS` seeds the admin with `mustChangePwd: true`, which would divert flow 1's login
 * straight into the change-password screen instead of the authenticated shell it exists to prove
 * renders. Exported so specs assert against the same value rather than a second hard-coded copy.
 */
export const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL || 'admin@example.com'
export const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD || '12345678'

/**
 * The quarantine lane's marker, per `docs/decisions/flaky-test-quarantine.md`: a
 * `*.flaky.spec.js` under `tests/` is out of the default run below and into
 * `npm run test:flaky` (`playwright.flaky.config.js`), which CI runs as its own report-only step.
 * Exported so that config selects the same files this one ignores, from one string.
 */
export const FLAKY_GLOB = '**/*.flaky.spec.js'

export default defineConfig({
  testDir: './tests',
  // -> `testMatch` defaults to every `*.spec.js` under `testDir`, which includes the lane, so the
  //    ignore below is what actually keeps a quarantined spec out of the default run.
  testIgnore: FLAKY_GLOB,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 30_000,
  expect: {
    timeout: 5_000
  },
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure'
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // -> Pinned rather than left to the `chromium` project's own device default: the markdown
        //    editor's preview pane -- which `tests/page-publish.spec.js` and `tests/multi-site.spec.js`
        //    both wait on as their signal that typed content has synced to the store -- only renders
        //    above a 1024px-wide viewport (`EditorMarkdown.vue`'s `useMinWidth(1024)`). This has to
        //    live in the project's own `use`, not the config-level `use` above: Playwright merges
        //    `config.use` and `projectConfig.use` shallowly per key with the project's value winning,
        //    and `devices['Desktop Chrome']` already sets its own `viewport` (1280x720) -- a
        //    config-level `viewport` here would lose that merge silently, which is exactly what
        //    happened before this comment was written (task 2026).
        viewport: { width: 1280, height: 800 }
      }
    }
  ],
  /*
    The "locally-built stack" the task calls for: `node backend`, run from the repo root exactly
    the way it runs in production (`index.ts` refuses to boot from any other cwd) and serving the
    frontend's `vite build` output from `assets/` -- not the dev-mode Vite proxy on :3001. Building
    that output is this config's one real precondition, left to whoever runs the suite (`npm run
    build` in `frontend/`, or CI's own build step) rather than triggered here, so a stale build
    fails obviously -- the smoke specs render actual page chrome, so a missing/old `assets/` shows
    up immediately as broken specs, not a silent pass against the wrong bundle.
  */
  webServer: {
    command: 'node backend',
    cwd: '..',
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      CONFIG_FILE: 'e2e/config.e2e.yml',
      DATABASE_URL: process.env.DATABASE_URL,
      WIKI_PORT: String(PORT),
      ADMIN_EMAIL,
      ADMIN_PASS: ADMIN_PASSWORD
    }
  }
})
