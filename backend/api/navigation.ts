import type { FastifyInstance, FastifyRequest } from 'fastify'
import {
  assertValidNavItems,
  NAV_COPY_MODES,
  NAVIGATION_MODES,
  NAVIGATION_SOURCE_MODES,
  type NavCopyMode,
  type NavigationItem,
  type NavigationMode,
  type NavigationSourceMode
} from '../models/navigation.ts'

/**
 * Whether the requester may see and edit a menu whole, rather than only the parts meant for them.
 *
 * `manage:navigation` keeps working exactly as before delegation existed; `site:navigation` (see
 * `helpers/siteRules.ts`) is the new, narrower alternative a rule can grant per site.
 */
function canManageNavigation(req: FastifyRequest, siteId: string): boolean {
  const actor = WIKI.models.groups.actorForRequest(req)
  return (
    actor.permissions.includes('manage:navigation') ||
    WIKI.models.groups.checkSiteAccess(actor, 'site:navigation', siteId)
  )
}

/**
 * Navigation API Routes
 *
 * A menu belongs to a tree entry that overrides it, addressed by that entry's own id, or to one
 * locale of the site itself for the one every page in that locale falls back to, addressed by that
 * row's own id (see `GET .../navigation/default`) rather than the site's — either way a single opaque
 * id, which is why there is a single route to read one.
 */
async function routes(app: FastifyInstance) {
  /**
   * GET NAVIGATION
   */
  app.get<{ Params: { siteId: string; navId: string }; Querystring: { full?: boolean } }>(
    '/sites/:siteId/navigation/:navId',
    {
      schema: {
        summary: 'Get a navigation menu',
        description:
          "The resolved items of one menu, addressed by the id a page's `navigationId` points at. For a `static` menu (still the default, and the only kind before this feature) that is the stored items unchanged; for `auto` it is a fresh tree walk instead, and for `mixed` it is the tree walk merged with the stored items per each item's `pinned` placement — so this is not always \"a column read verbatim\" the way it once was.\n\nReadable without a session, because the sidebar is drawn for anonymous readers too. Items limited to a group are dropped for anyone outside it, at both levels of the menu — so what comes back is what the requester may see, not the whole menu. A generated (`auto`/`mixed`) entry is additionally filtered per-item through the requester's own `read:pages` grant (OpenProject #2155) — a path, tag or classification DENY hides that entry (and drops an emptied-out folder) the same way it hides the page itself. `full` asks for the whole of the visibility-GROUP layer instead, and — since this is the preview an editor needs to see and edit the full `auto`/`mixed` structure, not just what their own access happens to include — it skips the per-item `read:pages` check too, the same as it already skips the visibility-group filter; both are back on for a non-`full` read. `full` needs `manage:navigation`, or `site:navigation` on this site. The response wraps the resolved items alongside the menu's own source mode, so a caller doesn't need a second request to learn it.",
        tags: ['Navigation'],
        params: {
          type: 'object',
          properties: {
            siteId: { type: 'string', format: 'uuid' },
            navId: { type: 'string', format: 'uuid' }
          },
          required: ['siteId', 'navId']
        },
        querystring: {
          type: 'object',
          properties: {
            full: {
              type: 'boolean',
              default: false,
              description: 'Include items limited to groups the requester is not in.'
            }
          }
        },
        response: {
          200: {
            description:
              "The resolved menu's own source mode, plus its items in the order they are shown",
            type: 'object',
            properties: {
              mode: { type: 'string', enum: NAVIGATION_SOURCE_MODES },
              items: {
                type: 'array',
                items: { $ref: 'NavigationItem#' }
              }
            },
            required: ['mode', 'items']
          },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const unfiltered = Boolean(req.query.full)
      if (unfiltered && !canManageNavigation(req, req.params.siteId)) {
        return reply.forbidden(
          'Reading a menu in full requires manage:navigation, or site:navigation on this site.'
        )
      }
      const [mode, items] = await Promise.all([
        WIKI.models.navigation.getMode(req.params.siteId, req.params.navId),
        WIKI.models.navigation.getNav(req.params.siteId, req.params.navId, {
          actor: WIKI.models.groups.actorForRequest(req),
          userGroups: req.session?.authenticated ? (req.session.groups ?? []) : [],
          unfiltered
        })
      ])
      return { mode, items }
    }
  )

  /**
   * GET A MENU'S SOURCE MODE
   */
  app.get<{ Params: { siteId: string; navId: string } }>(
    '/sites/:siteId/navigation/:navId/mode',
    {
      /*
        No route-level `permissions`: same reasoning as the inherited-menu GET below — see
        `canManageNavigation`.
      */
      schema: {
        summary: "Get a menu's source mode",
        description:
          "A menu row's own `mode` (`static`/`auto`/`mixed`) with no item resolution -- what `NavEditMenu.vue`'s mode selector asks before it has anything to save, so it can preselect the option actually stored rather than always defaulting to `static`. `static` for a menu with no row yet, the same fallback `GET /sites/:siteId/navigation/:navId` falls back to.\n\nRequires `manage:navigation`, or `site:navigation` on this site.",
        tags: ['Navigation'],
        params: {
          type: 'object',
          properties: {
            siteId: { type: 'string', format: 'uuid' },
            navId: { type: 'string', format: 'uuid' }
          },
          required: ['siteId', 'navId']
        },
        response: {
          200: {
            description: "The menu row's own source mode",
            type: 'object',
            properties: {
              mode: { type: 'string', enum: NAVIGATION_SOURCE_MODES }
            },
            required: ['mode']
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      if (!canManageNavigation(req, req.params.siteId)) {
        return reply.forbidden()
      }
      return { mode: await WIKI.models.navigation.getMode(req.params.siteId, req.params.navId) }
    }
  )

  /**
   * GET THE MENU A PAGE INHERITS
   */
  app.get<{ Params: { siteId: string; pageId: string } }>(
    '/sites/:siteId/navigation/pages/:pageId/inherited',
    {
      /*
        No route-level `permissions`: who may see this comes from `checkSiteAccess()`, which that
        hook cannot call — see `canManageNavigation`.
      */
      schema: {
        summary: 'Get the menu a page inherits',
        description:
          "The id of the menu this page falls back to while it inherits: the nearest ancestor that overrides one, or the site-wide menu when no ancestor does.\n\nWhat the navigation editor asks so that a page which inherits can edit the sidebar it shows without being opened on the ancestor that owns it. Null when the nearest ancestor hides the sidebar, which leaves nothing to inherit — and nothing to edit. Not the same question as the page's own `navigationId`, which is what the CURRENT mode resolved to.\n\nRequires `manage:navigation`, or `site:navigation` on this site.",
        tags: ['Navigation'],
        params: {
          type: 'object',
          properties: {
            siteId: { type: 'string', format: 'uuid' },
            pageId: { type: 'string', format: 'uuid' }
          },
          required: ['siteId', 'pageId']
        },
        response: {
          200: {
            description: 'The inherited menu',
            type: 'object',
            properties: {
              navigationId: {
                type: ['string', 'null'],
                description:
                  'The menu this page inherits. Null when the sidebar above it is hidden.'
              }
            }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      if (!canManageNavigation(req, req.params.siteId)) {
        return reply.forbidden()
      }
      return {
        navigationId: await WIKI.models.navigation.inheritedNavId(
          req.params.siteId,
          req.params.pageId
        )
      }
    }
  )

  /**
   * GET THE SITE-WIDE DEFAULT MENU'S ROW ID
   */
  app.get<{ Params: { siteId: string }; Querystring: { locale: string } }>(
    '/sites/:siteId/navigation/default',
    {
      /*
        No route-level `permissions`: same reasoning as the inherited-menu GET below — see
        `canManageNavigation`.
      */
      schema: {
        summary: "Get a locale's site-wide default menu row id",
        description:
          "The site-wide default menu's own row id for one locale — created empty on demand, exactly like editing a page into it would. Not the site id: the default menu is identified by `(siteId, locale)` rather than by an id equal to the site's own, since a site with more than one active locale has one such menu per locale. What an admin screen editing the default menu directly (rather than through a page) asks for, since it otherwise has no way to learn that id.\n\nRequires `manage:navigation`, or `site:navigation` on this site.",
        tags: ['Navigation'],
        params: {
          type: 'object',
          properties: {
            siteId: { type: 'string', format: 'uuid' }
          },
          required: ['siteId']
        },
        querystring: {
          type: 'object',
          properties: {
            locale: { type: 'string' }
          },
          required: ['locale']
        },
        response: {
          200: {
            description: "This locale's site-wide default menu row",
            type: 'object',
            properties: {
              navigationId: { type: 'string', description: 'The row id, never the site id.' }
            }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      if (!canManageNavigation(req, req.params.siteId)) {
        return reply.forbidden()
      }
      return {
        navigationId: await WIKI.models.navigation.ensureSiteNav(
          req.params.siteId,
          req.query.locale
        )
      }
    }
  )

  /**
   * LIST THE SITE-WIDE DEFAULT MENU ROOTS, ONE PER ACTIVE LOCALE
   */
  app.get<{ Params: { siteId: string } }>(
    '/sites/:siteId/navigation/roots',
    {
      /*
        No route-level `permissions`: same reasoning as the inherited-menu GET below — see
        `canManageNavigation`.
      */
      schema: {
        summary: "List a site's default menu roots, one per active locale",
        description:
          "The site-wide default menu's own row id for every one of this site's active locales (`site.config.locales.active`) — created empty on demand, exactly like `GET .../navigation/default` does for a single locale. What a 'copy from' picker lists so an admin can choose a source menu by locale, or by site via `GET /sites` followed by this same call against the chosen site, without needing to know a raw navigation uuid up front.\n\nDeliberately scoped to the site-wide default only, not every override — copying a specific page-level override across sites isn't a use case this covers; see `GET .../navigation/overrides` for those.\n\nRequires `manage:navigation`, or `site:navigation` on this site.",
        tags: ['Navigation'],
        params: {
          type: 'object',
          properties: {
            siteId: { type: 'string', format: 'uuid' }
          },
          required: ['siteId']
        },
        response: {
          200: {
            description: "This site's default menu roots, one per active locale",
            type: 'array',
            items: {
              type: 'object',
              properties: {
                locale: { type: 'string' },
                navigationId: { type: 'string', description: 'The row id, never the site id.' }
              }
            }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      if (!canManageNavigation(req, req.params.siteId)) {
        return reply.forbidden()
      }
      if (!WIKI.sites[req.params.siteId]) {
        return reply.notFound('This site does not exist.')
      }
      return WIKI.models.navigation.siteRoots(req.params.siteId)
    }
  )

  /**
   * LIST NAVIGATION OVERRIDES
   */
  app.get<{ Params: { siteId: string }; Querystring: { locale?: string } }>(
    '/sites/:siteId/navigation/overrides',
    {
      /*
        No route-level `permissions`: same reasoning as the inherited-menu GET below — see
        `canManageNavigation`.
      */
      schema: {
        summary: 'List navigation overrides',
        description:
          'Every tree entry in the site whose navigation mode is not `inherit` — the pages and folders that override or hide the sidebar, rather than falling back to whatever an ancestor decides. A flat list across the whole site, not scoped to one subtree, which is what an admin screen managing overrides needs to show them all at once.\n\n`locale` restricts it to one locale; every locale comes back when omitted.\n\nRequires `manage:navigation`, or `site:navigation` on this site.',
        tags: ['Navigation'],
        params: {
          type: 'object',
          properties: {
            siteId: { type: 'string', format: 'uuid' }
          },
          required: ['siteId']
        },
        querystring: {
          type: 'object',
          properties: {
            locale: { type: 'string', description: 'Restrict the list to this locale.' }
          }
        },
        response: {
          200: {
            description:
              'Tree entries overriding navigation, ordered by folder path then file name',
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', format: 'uuid' },
                type: { type: 'string', enum: ['folder', 'page', 'asset'] },
                folderPath: { type: 'string' },
                fileName: { type: 'string' },
                title: { type: 'string' },
                locale: { type: 'string' },
                navigationMode: { type: 'string', enum: NAVIGATION_MODES },
                navigationId: { type: ['string', 'null'] }
              }
            }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      if (!canManageNavigation(req, req.params.siteId)) {
        return reply.forbidden()
      }
      return WIKI.models.navigation.listOverrides(req.params.siteId, {
        locale: req.query.locale
      })
    }
  )

  /**
   * SET NAVIGATION ITEMS
   */
  app.put<{
    Params: { siteId: string; navId: string }
    Body: { items: NavigationItem[] }
  }>(
    '/sites/:siteId/navigation/:navId',
    {
      /*
        No route-level `permissions`: same reasoning as the inherited-menu GET below — see
        `canManageNavigation`.
      */
      schema: {
        summary: "Set a menu's items directly",
        description:
          "Writes a menu's items straight to the row named by `navId`, with no page or mode resolution.\n\nFor a caller that already knows exactly which row it means — a locale's site-wide default (its own row id from `GET /sites/:siteId/navigation/default`) or an override's own `navigationId` from `GET /sites/:siteId/navigation/overrides` — rather than one editing the sidebar of a particular page, which should keep using `PUT /sites/:siteId/navigation/pages/:pageId` so that saving from a page that inherits repoints at the ancestor it inherits from. Refused when `navId` names neither an existing menu row of this site nor one of its own tree entries.\n\nRequires `manage:navigation`, or `site:navigation` on this site.",
        tags: ['Navigation'],
        params: {
          type: 'object',
          properties: {
            siteId: { type: 'string', format: 'uuid' },
            navId: { type: 'string', format: 'uuid' }
          },
          required: ['siteId', 'navId']
        },
        body: {
          type: 'object',
          required: ['items'],
          properties: {
            items: {
              type: 'array',
              items: { $ref: 'NavigationItem#' }
            }
          }
        },
        response: {
          200: {
            description: 'Navigation updated successfully',
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              message: { type: 'string' }
            }
          },
          400: { $ref: 'ApiError#' },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      if (!canManageNavigation(req, req.params.siteId)) {
        return reply.forbidden()
      }
      assertValidNavItems(req.body.items)
      await WIKI.models.navigation.setNavItems(req.params.siteId, req.params.navId, req.body.items)
      return {
        ok: true,
        message: 'Navigation updated successfully.'
      }
    }
  )

  /**
   * COPY NAVIGATION
   */
  app.post<{
    Params: { siteId: string; targetNavId: string }
    Body: { sourceSiteId?: string; sourceNavId: string; mode: NavCopyMode }
  }>(
    '/sites/:siteId/navigation/:targetNavId/copy',
    {
      /*
        No route-level `permissions`: same reasoning as the inherited-menu GET below — see
        `canManageNavigation`. Checked against BOTH the target site and, when it differs, the
        resolved source site: `site:navigation` is granted per site (OpenProject #933's own
        `helpers/siteRules.ts` — a rule's `sites` array can scope it to exactly one), so a caller
        delegated only on the target could otherwise use `sourceSiteId` to read and duplicate a
        DIFFERENT site's menu into the target without ever holding a permission on that site at all.
      */
      schema: {
        summary: 'Copy a menu onto another',
        description:
          "Clones a source menu's items onto the target named by `targetNavId`, giving every item — top-level and nested child alike — a fresh id so the target's sortable list never collides with the source's.\n\n`sourceSiteId` defaults to the path's `:siteId`, which is the same-site case — copying one locale's menu onto another within one site, matching 2.5.x's 'copy from locale'. Giving a different `sourceSiteId` is the cross-site case. `mode: replace` overwrites the target's items outright; `mode: append` pushes the clones onto whatever the target already has. `visibilityGroups` travel over unchanged, since groups are instance-wide; item `target` paths are copied unrewritten, which is a known best-effort limitation, same as 2.5.x. Refused when the source or target id does not name an existing menu row.\n\nRequires `manage:navigation`, or `site:navigation` on the target site — and, when `sourceSiteId` names a different site, `site:navigation` on that site too.",
        tags: ['Navigation'],
        params: {
          type: 'object',
          properties: {
            siteId: { type: 'string', format: 'uuid' },
            targetNavId: { type: 'string', format: 'uuid' }
          },
          required: ['siteId', 'targetNavId']
        },
        body: {
          type: 'object',
          required: ['sourceNavId', 'mode'],
          properties: {
            sourceSiteId: {
              type: 'string',
              format: 'uuid',
              description: "Site the source menu belongs to. Defaults to the path's siteId."
            },
            sourceNavId: { type: 'string', format: 'uuid' },
            mode: {
              type: 'string',
              enum: NAV_COPY_MODES,
              description:
                'replace overwrites the target items; append pushes the clones onto the existing ones.'
            }
          }
        },
        response: {
          200: {
            description: 'Navigation copied successfully',
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              message: { type: 'string' }
            }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      if (!canManageNavigation(req, req.params.siteId)) {
        return reply.forbidden()
      }
      const sourceSiteId = req.body.sourceSiteId ?? req.params.siteId
      if (sourceSiteId !== req.params.siteId && !canManageNavigation(req, sourceSiteId)) {
        return reply.forbidden()
      }
      await WIKI.models.navigation.copyNav({
        sourceSiteId,
        sourceId: req.body.sourceNavId,
        targetSiteId: req.params.siteId,
        targetId: req.params.targetNavId,
        mode: req.body.mode
      })
      return {
        ok: true,
        message: 'Navigation copied successfully.'
      }
    }
  )

  /**
   * UPDATE NAVIGATION
   */
  app.put<{
    Params: { siteId: string; pageId: string }
    Body: { mode: NavigationMode; items?: NavigationItem[]; menuMode?: NavigationSourceMode }
  }>(
    '/sites/:siteId/navigation/pages/:pageId',
    {
      /*
        No route-level `permissions`: same reasoning as the inherited-menu GET above — see
        `canManageNavigation`.
      */
      schema: {
        summary: 'Set how a page resolves its navigation',
        description:
          "Records the mode on the tree entry and repoints every descendant that still inherits, stopping at any that overrides or hides in between.\n\nSending `items` stores them as the menu the mode resolves to, and leaving them out changes only the mode. With `inherit` that menu belongs to an ancestor — the same one `navigation/pages/{pageId}/inherited` names — so editing a menu from a page that inherits it edits it where it lives, for every page using it; for the home page that is the site-wide menu, which is what every other page inherits by default. Refused when the mode is `inherit` and the sidebar above the page is hidden, since then there is no menu to store items in.\n\n`mode` and `menuMode` are different axes: `mode` is this ENTRY's cascade setting (how it and its descendants pick a menu), `menuMode` is the RESOLVED MENU's own source (`static`/`auto`/`mixed` — whether its items are hand-authored, tree-generated, or both). Sending `menuMode` sets it on the same row `items` would write to; either can be sent without the other.\n\nRequires `manage:navigation`, or `site:navigation` on this site.",
        tags: ['Navigation'],
        params: {
          type: 'object',
          properties: {
            siteId: { type: 'string', format: 'uuid' },
            pageId: { type: 'string', format: 'uuid' }
          },
          required: ['siteId', 'pageId']
        },
        body: {
          type: 'object',
          required: ['mode'],
          properties: {
            mode: {
              type: 'string',
              enum: NAVIGATION_MODES
            },
            items: {
              type: 'array',
              items: { $ref: 'NavigationItem#' }
            },
            menuMode: {
              type: 'string',
              enum: NAVIGATION_SOURCE_MODES,
              description:
                "The resolved menu's own source mode (`static`/`auto`/`mixed`) -- a different axis from `mode` above, which is this entry's cascade setting. Leaving it out changes only `mode`/`items`, not the menu's source."
            }
          }
        },
        response: {
          200: {
            description: 'Navigation updated successfully',
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              message: { type: 'string' },
              navigationMode: { type: 'string' },
              navigationId: {
                type: ['string', 'null'],
                description: 'The menu this page now resolves to. Null when the sidebar is hidden.'
              },
              mode: {
                type: 'string',
                enum: NAVIGATION_SOURCE_MODES,
                description:
                  "The resolved menu's own source mode. Present only when `menuMode` was sent in the request, echoing back what was just written."
              }
            }
          },
          400: { $ref: 'ApiError#' },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      if (!canManageNavigation(req, req.params.siteId)) {
        return reply.forbidden()
      }
      if (req.body.items) {
        assertValidNavItems(req.body.items)
      }
      const result = await WIKI.models.navigation.updateNavigation({
        siteId: req.params.siteId,
        pageId: req.params.pageId,
        mode: req.body.mode,
        items: req.body.items,
        menuMode: req.body.menuMode
      })
      return {
        ok: true,
        message: 'Navigation updated successfully.',
        ...result
      }
    }
  )
}

export default routes
