/**
 * Structural check that the Postgres major version used across every place that spins up a real
 * Postgres for this repo's tests stays in step (work package #1980, following up on #976 — which
 * bumped the four workflow/devcontainer service definitions from `postgres:17` to `postgres:18` but
 * left `e2e/playwright.config.js`'s own hint text quoting the old version, since that text isn't a
 * service definition itself and so wasn't touched by the same grep-and-replace).
 *
 * Not "does Postgres actually boot" — that's what the DB-backed suites gated on `DATABASE_URL`
 * already prove. This only asserts the four service definitions (`quality.yml`, `build.yml`,
 * `e2e.yml`, `.devcontainer/docker-compose.yml`) and the version `e2e/playwright.config.js` tells a
 * developer to run locally all name the same major version, so a future bump to one doesn't quietly
 * leave the others — or the doc text — behind.
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { load } from 'js-yaml'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')

/** Pulls the Postgres major version out of the first `postgres:<major>` image tag found. */
function postgresMajor(text: string): string {
  const match = text.match(/postgres:(\d+)/)
  assert.ok(match, `expected a "postgres:<major>" image tag, found none in:\n${text}`)
  return match![1]!
}

/** Reads a workflow YAML file and returns its `services.postgres.image` from whichever job has it. */
function workflowPostgresImage(relPath: string): string {
  const raw = fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8')
  const doc: any = load(raw)
  const image = Object.values<any>(doc.jobs ?? {})
    .map((job: any) => job.services?.postgres?.image)
    .find(Boolean)
  assert.ok(image, `${relPath}: expected some job with a \`services.postgres.image\``)
  return image as string
}

describe('Postgres major version stays consistent across service definitions (#1980)', () => {
  const definitions = [
    { label: 'quality.yml', image: workflowPostgresImage('.github/workflows/quality.yml') },
    { label: 'build.yml', image: workflowPostgresImage('.github/workflows/build.yml') },
    { label: 'e2e.yml', image: workflowPostgresImage('.github/workflows/e2e.yml') },
    {
      label: '.devcontainer/docker-compose.yml',
      image: (() => {
        const raw = fs.readFileSync(
          path.join(REPO_ROOT, '.devcontainer/docker-compose.yml'),
          'utf8'
        )
        const doc: any = load(raw)
        const image = doc.services?.db?.image
        assert.ok(image, '.devcontainer/docker-compose.yml: expected services.db.image')
        return image as string
      })()
    }
  ]

  test('all four service definitions pin the same Postgres major version', () => {
    const majors = definitions.map((d) => ({ label: d.label, major: postgresMajor(d.image) }))
    const [first, ...rest] = majors
    for (const entry of rest) {
      assert.equal(
        entry.major,
        first!.major,
        `${entry.label} pins postgres:${entry.major}, but ${first!.label} pins postgres:${first!.major}`
      )
    }
  })

  test("e2e/playwright.config.js's hint text quotes the same major version", () => {
    const raw = fs.readFileSync(path.join(REPO_ROOT, 'e2e/playwright.config.js'), 'utf8')
    const expectedMajor = postgresMajor(definitions[0]!.image)
    const mentions = [...raw.matchAll(/postgres:(\d+)/g)].map((m) => m[1])
    assert.ok(
      mentions.length > 0,
      'expected at least one postgres:<major> mention in playwright.config.js'
    )
    for (const major of mentions) {
      assert.equal(major, expectedMajor)
    }
  })
})
