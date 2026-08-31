import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * OpenProject #1929: `/admin/scheduler` names a job-scheduler concept this fork invented (no upstream
 * Wiki.js docs site can describe it), so the `docsBase`-based help button was deleted rather than left
 * pointing at a page that does not exist. Reads the raw source rather than mounting the component --
 * `AdminScheduler.vue` polls the scheduler API and pulls in several composables, and a full mount is
 * out of proportion for asserting that some markup is simply gone -- so this also guards against the
 * button quietly being reintroduced.
 */
const source = readFileSync(join(import.meta.dirname, 'AdminScheduler.vue'), 'utf-8')

describe('AdminScheduler help link', () => {
  it('has no docsBase-based help/docs button', () => {
    expect(source).not.toContain('docsBase')
  })
})
