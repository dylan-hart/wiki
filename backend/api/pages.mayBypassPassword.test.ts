import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { mayBypassPassword } from './pages.ts'

/**
 * Characterization test for the `mayBypassPassword()` discrepancy investigated by task #781
 * (feature #425, "variances.md discipline and documentation debt sweep").
 *
 * `PASSWORD_BYPASS` names `write:pages` and `manage:pages` — both **page-rule** permissions
 * (`PAGE_PERMISSIONS` in this same file), granted per path by a group's `rules` column
 * (`db/schema.ts`'s `groups.rules`). But `mayBypassPassword()` only ever reads
 * `req.session.permissions`, which `models/users.ts`'s `updateSession()` populates solely from a
 * group's *global* `permissions` column — the closed set of seven names offered by
 * `GroupEditOverlay.vue` (`access:admin`, `manage:users`, `manage:groups`, `manage:navigation`,
 * `manage:theme`, `manage:sites`, `manage:system`), which does not and cannot include
 * `write:pages` / `manage:pages`. `rules` is never folded into `req.session.permissions`.
 *
 * The result: an editor who holds `write:pages` on a page only through a path rule — not through
 * `manage:system` — is never recognized by `mayBypassPassword()`, even though `mayOnPage(req,
 * 'write:pages', page)` (which calls `WIKI.models.groups.checkAccess()`, the real, live per-path
 * rule engine) would say yes. They are asked for the page's password despite being able to open it
 * in the editor and remove the password outright.
 *
 * This test documents that CURRENT behavior — it is not a fix. It passes today because the bug is
 * real; a future fix (tracked as a candidate under feature #422) will need `mayBypassPassword` to
 * take the page in hand and call `mayOnPage`/`checkAccess` instead of reading the flat session
 * list, at which point this exact scenario should flip to `true` and this test must be updated
 * alongside it.
 */

before(() => {
  ;(globalThis as any).WIKI = {
    models: {
      groups: {
        actorForRequest: (req: any) => ({ permissions: req.session?.permissions ?? [] }),
        // -> Stands in for the real per-path rule engine: this actor DOES hold write:pages here,
        //    granted by a path rule rather than a global permission.
        checkAccess: (_actor: any, permission: string) => permission === 'write:pages'
      }
    }
  }
})

after(() => {
  delete (globalThis as any).WIKI
})

test('an editor holding write:pages only via a page rule is not recognized by mayBypassPassword', () => {
  const page = { path: 'some/path', locale: 'en', tags: [] }
  const req: any = {
    session: {
      // -> No manage:system, and no write:pages/manage:pages either: those two are page-rule
      //    permissions and are never written here by updateSession().
      permissions: []
    }
  }

  // The rule engine says this requester may write the page...
  assert.equal(
    WIKI.models.groups.checkAccess(WIKI.models.groups.actorForRequest(req), 'write:pages', page),
    true
  )

  // ...but mayBypassPassword() cannot see that, because it never consults the rule engine.
  assert.equal(mayBypassPassword(req), false)
})

test('manage:system in session.permissions does bypass, since it is a real global permission', () => {
  const req: any = { session: { permissions: ['manage:system'] } }
  assert.equal(mayBypassPassword(req), true)
})
