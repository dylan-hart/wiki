import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

/**
 * Regression test for task 678: `searchPages`'s actor-scoped results filter runs each row through
 * `WIKI.models.groups.checkAccess`, but the inline page ref it built never carried `siteId` — so a
 * rule scoped to one site (task 671) could not distinguish this site's results from another's.
 * `siteId` is already in `searchPages`'s enclosing scope; this only proves it reaches the
 * `checkAccess` call made over the filtered rows.
 */

let checkAccessCalls: any[] = []

before(async () => {
  ;(globalThis as any).WIKI = {
    config: {},
    sites: {},
    db: {
      execute: async () => ({
        rows: [
          {
            id: 'page-1',
            path: 'engineering/onboarding',
            locale: 'en',
            title: 'Onboarding',
            description: null,
            icon: null,
            tags: ['guide'],
            updatedAt: '2026-01-01T00:00:00.000Z',
            relevancy: 0,
            highlight: null,
            totalHits: 1
          }
        ]
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

test('searchPages: threads siteId into the RulePageRef passed to checkAccess', async () => {
  checkAccessCalls = []
  const { search } = await import('./search.ts')

  await search.searchPages({
    siteId: '11111111-1111-4111-8111-111111111111',
    actor: { groupIds: [], permissions: [] } as any
  })

  assert.equal(checkAccessCalls.length, 1)
  assert.equal(checkAccessCalls[0].siteId, '11111111-1111-4111-8111-111111111111')
})
