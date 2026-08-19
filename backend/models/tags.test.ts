import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

/**
 * Regression test for task 678: `getTags`'s actor-scoped branch filters pages through
 * `WIKI.models.groups.checkAccess`, but the inline page ref it built never carried `siteId` — so a
 * rule scoped to one site (task 671) could not tell this site's pages from another's when a tag
 * listing was actor-filtered. `siteId` is already a named parameter of `getTags` itself; this only
 * proves it reaches the `checkAccess` call.
 */

let checkAccessCalls: any[] = []

before(async () => {
  ;(globalThis as any).WIKI = {
    db: {
      execute: async () => ({
        rows: [{ path: 'engineering/onboarding', locale: 'en', tags: ['guide'] }]
      })
    },
    models: {
      groups: {
        checkAccess: (actor: any, permission: string, page: any) => {
          checkAccessCalls.push(page)
          return true
        }
      }
    }
  }
})

after(() => {
  delete (globalThis as any).WIKI
})

test('getTags: threads siteId into the RulePageRef passed to checkAccess', async () => {
  checkAccessCalls = []
  const { tags } = await import('./tags.ts')

  await tags.getTags('11111111-1111-4111-8111-111111111111', {
    actor: { groupIds: [], permissions: [] } as any
  })

  assert.equal(checkAccessCalls.length, 1)
  assert.equal(checkAccessCalls[0].siteId, '11111111-1111-4111-8111-111111111111')
})
