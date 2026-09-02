import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { approvalRules } from './approvalRules.ts'
import { installTestWiki } from '../test/mocks.ts'

describe('approvals pageViewerState siteId threading (task 678)', () => {
  /**
   * Regression test for task 678: `pageViewerState`'s reviewer-scope check calls
   * `WIKI.models.groups.checkAccess` directly (not through `mayOnPage`/`mayOnAsset`, so task 673's
   * fix never touched it), but the inline page ref it built never carried `siteId` — so a
   * `review:pages` rule scoped to one site (task 671) could not tell this site apart from another's.
   * `siteId` is already `pageViewerState`'s second parameter; this only proves it reaches the
   * `checkAccess` call.
   *
   * The reviewer-scope `checkAccess` call is only reached for an authenticated session whose group
   * permissions don't already include `manage:system` (that short-circuits first).
   * `allowContributions: false` on the page ref keeps `findSubmitRule`/`getOwnSubmission` from
   * needing a real DB.
   */

  let checkAccessCalls: any[] = []
  let wiki: { restore(): void }

  before(async () => {
    wiki = installTestWiki({
      models: {
        // -> The real singleton: `findSubmitRule`/`canReviewPage` read the rules through it, and its
        //    module-level cache is empty here, so both answer from an empty rule set with no query.
        approvalRules,
        groups: {
          actorForRequest: () => ({ groupIds: [], permissions: [] }),
          // -> `reviewerScopeFor` resolves `viewerId` through `helpers/pageAccess.ts#actorFrom`,
          //    which asks for the session's groups on its way to the user id.
          groupIdsForRequest: () => [],
          checkAccess: (actor: any, permission: string, page: any) => {
            checkAccessCalls.push(page)
            return true
          }
        }
      }
    })
  })

  after(() => wiki.restore())

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
      locale: 'en',
      tags: [],
      allowContributions: false,
      classification: null
    })

    assert.equal(checkAccessCalls.length, 1)
    assert.equal(checkAccessCalls[0].siteId, '11111111-1111-4111-8111-111111111111')
    // -> Task 992: the ref's locale threads through too, same as siteId did for task 678
    assert.equal(checkAccessCalls[0].locale, 'en')
  })
})
