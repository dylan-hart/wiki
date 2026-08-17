import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

/**
 * Regression test for task 678: `pageViewerState`'s reviewer-scope check calls
 * `WIKI.models.groups.checkAccess` directly (not through `mayOnPage`/`mayOnAsset`, so task 673's fix
 * never touched it), but the inline page ref it built never carried `siteId` — so a `review:pages`
 * rule scoped to one site (task 671) could not tell this site apart from another's. `siteId` is
 * already `pageViewerState`'s second parameter; this only proves it reaches the `checkAccess` call.
 *
 * The reviewer-scope `checkAccess` call is only reached for an authenticated session whose group
 * permissions don't already include `manage:system` (that short-circuits first). `allowContributions:
 * false` on the page ref keeps `findSubmitRule`/`getOwnSubmission` from needing a real DB.
 */

let checkAccessCalls: any[] = []

before(async () => {
  ;(globalThis as any).WIKI = {
    models: {
      groups: {
        actorForRequest: () => ({ groupIds: [], permissions: [] }),
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

test('pageViewerState: threads siteId into the RulePageRef passed to checkAccess', async () => {
  checkAccessCalls = []
  const { approvals } = await import('./approvals.ts')

  const req = {
    session: {
      authenticated: true,
      user: { id: 'user-1' },
      groups: [],
      permissions: []
    }
  }

  await approvals.pageViewerState(req, '11111111-1111-4111-8111-111111111111', {
    id: 'page-1',
    path: 'engineering/onboarding',
    tags: [],
    allowContributions: false
  })

  assert.equal(checkAccessCalls.length, 1)
  assert.equal(checkAccessCalls[0].siteId, '11111111-1111-4111-8111-111111111111')
})
