import { defineConfig, devices } from '@playwright/test'

/**
 * `E2E_PORT` is a local escape hatch for a developer machine where something else already holds
 * :3000. Overridden here rather than in `config.e2e.yml`, so the on-disk default stays :3000.
 */
const PORT = process.env.E2E_PORT || 3000
const BASE_URL = `http://localhost:${PORT}`

/**
 * Failing here, before Playwright spawns the webServer, turns a missing `DATABASE_URL` into one
 * readable line instead of the `webServer` boot timeout it would otherwise surface as.
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
      'database" true on every invocation.'
  )
}

/**
 * Set explicitly so `ADMIN_PASS` is defined at seed time: `models/users.ts`'s `init()` invents a
 * random password and seeds `mustChangePwd: true` without one, which diverts every spec's login
 * into the change-password screen. Exported so specs assert against one value, not a second copy.
 */
export const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL || 'admin@example.com'
export const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD || '12345678'

/**
 * The quarantine lane's marker. Exported so `playwright.flaky.config.js` selects exactly the files
 * this config ignores, from one string.
 */
export const FLAKY_GLOB = '**/*.flaky.spec.js'

export default defineConfig({
  testDir: './tests',
  // -> `testMatch` defaults to every `*.spec.js` under `testDir`, the lane included, so this is
  //    what actually keeps a quarantined spec out of the default run.
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
        // -> The markdown editor's preview pane, which the page-creation helper waits on as its
        //    signal that typed content synced to the store, only renders above a 1024px-wide
        //    viewport (`EditorMarkdown.vue`'s `useMinWidth(1024)`). It has to live in the project's
        //    own `use`: Playwright merges `config.use` and `projectConfig.use` shallowly per key
        //    with the project winning, and `devices['Desktop Chrome']` already sets a `viewport`,
        //    so a config-level one would lose that merge silently.
        viewport: { width: 1280, height: 800 }
      }
    }
  ],
  /*
    `node backend` from the repo root, the way it runs in production (`index.ts` refuses any other
    cwd), serving the frontend's `vite build` output from `assets/` -- not the dev-mode Vite proxy.
    Building that output is this config's one precondition and is deliberately left to whoever runs
    the suite rather than triggered here, so a stale or missing `assets/` shows up as broken specs
    rather than a silent pass against the wrong bundle.
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
