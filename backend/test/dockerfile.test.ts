/**
 * Structural checks on `dev/build/Dockerfile` (WP #1908, part of Epic #1905).
 *
 * `dev/build/` has no `package.json` of its own — it is packaging config, not a workspace — so
 * there is no co-located home for a Dockerfile test. This follows the same "repo-root doc/config
 * with no backend-workspace file to sit next to" pattern as `changelog.test.ts` /
 * `release-workflow.test.ts` / `releasing-doc.test.ts`: assert against the file's actual content
 * rather than trusting prose about it.
 *
 * What's asserted:
 *  - The declared VOLUME is the real persistent directory, `dataPath` = `/wiki/data`
 *    (`dev/build/config.yml`'s `dataPath: ./data` under `WORKDIR /wiki`) — not the 2.x-era
 *    `/wiki/data/content` path nothing under `backend/` writes to.
 *  - No leftover `/logs` directory setup or `EXPOSE 3443` — `core/logger.ts` has no file
 *    destination, and the server never constructs an HTTPS listener (`docs/tls-termination.md`).
 *  - A `HEALTHCHECK` hits the real readiness endpoint (`readinessEndpoint: '/_ready'` in
 *    `backend/index.ts`) with a generous `--start-period`, since `postBoot()` finishes after the
 *    HTTP server starts listening.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const DOCKERFILE = path.join(REPO_ROOT, 'dev/build/Dockerfile')

describe('dev/build/Dockerfile', () => {
  test('exists', () => {
    assert.ok(fs.existsSync(DOCKERFILE), `expected ${DOCKERFILE} to exist`)
  })

  const raw = fs.readFileSync(DOCKERFILE, 'utf8')

  test('declares VOLUME as the real dataPath, /wiki/data', () => {
    assert.match(raw, /^VOLUME \["\/wiki\/data"\]$/m)
  })

  test('does not declare the stale 2.x /wiki/data/content path anywhere', () => {
    assert.doesNotMatch(raw, /data\/content/)
  })

  test('does not set up a /logs directory', () => {
    assert.doesNotMatch(raw, /\/logs/)
  })

  test('does not EXPOSE 3443', () => {
    assert.doesNotMatch(raw, /3443/)
  })

  test('still EXPOSEs 3000, the real HTTP port', () => {
    assert.match(raw, /^EXPOSE 3000$/m)
  })

  test('declares a HEALTHCHECK against the real /_ready endpoint', () => {
    assert.match(raw, /^HEALTHCHECK\b/m)
    assert.match(raw, /\/_ready/)
  })

  test('HEALTHCHECK sets a generous --start-period', () => {
    const healthcheckLine = raw.split('\n').find((line) => line.startsWith('HEALTHCHECK'))
    assert.ok(healthcheckLine, 'expected a HEALTHCHECK instruction')
    const match = healthcheckLine!.match(/--start-period=(\d+)([ms])/)
    assert.ok(match, `expected --start-period on: ${healthcheckLine}`)
    const [, amount, unit] = match!
    const seconds = unit === 'm' ? Number.parseInt(amount, 10) * 60 : Number.parseInt(amount, 10)
    // postBoot() (locale/strategy/site refresh, scheduler start) runs after the HTTP server is
    // already listening -- a short start-period would let Docker mark the container unhealthy
    // before postBoot() finishes, or let /_ready be probed as ready before it actually is.
    assert.ok(seconds >= 30, `expected --start-period of at least 30s, got ${healthcheckLine}`)
  })

  test('curl is installed, since the HEALTHCHECK CMD depends on it', () => {
    assert.match(raw, /apt-get install[\s\S]*?\bcurl\b/)
  })
})
