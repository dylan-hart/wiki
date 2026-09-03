import type { FastifyInstance, FastifyReply } from 'fastify'
import type { PageInput } from '../../models/pages.ts'
import { CustomError, normalizePagePath } from '../../helpers/common.ts'
import { defaultLocale } from '../../helpers/localeRouting.ts'
import { limitRenders } from '../../helpers/rateLimit.ts'
import { actorFrom, mayOnPage } from '../../helpers/pageAccess.ts'
import { recordClassificationChange } from './classification.ts'

/**
 * `ensureCanRender()` (`models/renderQueue.ts`) throws these two named errors -- via `createPage()`/
 * `updatePage()` (OpenProject #1716) -- when a render-less write can't be safely accepted: an editor
 * this server has no renderer for, or a markdown page with no Puppeteer extension to render it. Maps
 * each to a `@fastify/sensible` error carrying `ensureCanRender()`'s own message (which names the
 * editor or the missing extension), reusing the exact wording the existing recovery route
 * (`POST …/pages/:pageId/render`, below) already 503s with rather than inventing a second one
 * (OpenProject #1720). Returns the sent reply once handled, or `null` for any other error so the
 * caller rethrows it for the generic `setErrorHandler` in `index.ts` to shape.
 */
function replyForRenderRefusal(err: any, reply: FastifyReply): FastifyReply | null {
  if (!(err instanceof CustomError)) {
    return null
  }
  if (err.name === 'renderPuppeteerMissing') {
    return reply.serviceUnavailable(err.message)
  }
  if (err.name === 'renderUnsupportedEditor') {
    return reply.badRequest(err.message)
  }
  return null
}

/**
 * Write-side page routes: creating, editing, moving, re-rendering, deleting a page, and the bulk
 * action that does several of those to a selection at once.
 */
async function routes(app: FastifyInstance) {
  /**
   * CREATE PAGE
   */
  app.post<{ Params: { siteId: string }; Body: PageInput }>(
    '/sites/:siteId/pages',
    {
      /*
        No route-level `permissions`: that hook reads the group-wide list, and page permissions are
        granted by a group's RULES. Checked against the page in question below instead — which is
        also what lets a rule open one branch to somebody the group as a whole cannot write to.
      */
      schema: {
        summary: 'Create a page',
        description:
          'The content is the source and `render` is the HTML the editor produced from it. The render is sanitized against what the author may embed, stripped of editor scaffolding, given heading anchors, and reduced to a table of contents and search text — so read the response rather than assuming what was sent is what was stored.',
        tags: ['Pages'],
        params: { $ref: 'SiteIdParams#' },
        body: {
          allOf: [
            { $ref: 'PageInput#' },
            { type: 'object', required: ['path', 'title', 'editor', 'content'] }
          ]
        },
        response: {
          200: {
            description: 'Page created successfully',
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              message: { type: 'string' },
              page: { $ref: 'Page#' }
            }
          },
          400: {
            $ref: 'ApiError#',
            description:
              'The declared editor has no server-side renderer, and this write carried content with no explicit render for it to fall back on.'
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          503: {
            $ref: 'ApiError#',
            description:
              'This write carried content with no explicit render, and the instance has no Puppeteer extension installed to produce one server-side.'
          }
        }
      }
    },
    async (req, reply) => {
      // -> A site-scoped key may not reach a site it isn't scoped to -- now enforced globally by
      //    `apiKeySitePinHook` in `index.ts` for every `/sites/:siteId/...` route, this one
      //    included; see `helpers/apiKeySite.ts`.
      const actor = actorFrom(req)
      if (!actor) {
        return reply.unauthorized('Saving a page requires a logged in user.')
      }
      // -> Against where the page is going: there is no page to ask about yet, and specifically no
      //    `tags` (feature 357, task 446 audit) — a page being created has none until it is saved,
      //    so there is nothing for a tag-scoped rule to match on here. `locale` is known up front
      //    from the request body and is passed.
      const createPageRef = {
        path: req.body.path,
        locale: req.body.locale ?? defaultLocale(req.params.siteId)
      }
      if (!mayOnPage(req, 'write:pages', req.params.siteId, createPageRef)) {
        return reply.forbidden('You are not allowed to create a page here.')
      }
      /*
        OpenProject #2467: creating a page with an immediately-published state needs `publish:pages`
        ON THIS PAGE, on top of `write:pages` -- the writer/publisher split (#2421) means being able
        to write a page does not by itself mean being able to publish it live. `publishState` defaults
        to `'published'` when omitted (`models/pages.ts#createPage()`), so an omitted value counts as
        immediate publish too; only an explicit `'draft'` or `'scheduled'` skips this check, following
        the same shape as the `manage:classification` declassification guardrail below.
      */
      if (
        (req.body.publishState ?? 'published') === 'published' &&
        !mayOnPage(req, 'publish:pages', req.params.siteId, createPageRef)
      ) {
        return reply.forbidden(
          'Publishing a page immediately requires the publish:pages permission here.'
        )
      }
      let page
      try {
        page = await WIKI.models.pages.createPage(req.params.siteId, req.body, actor)
      } catch (err: any) {
        const refusal = replyForRenderRefusal(err, reply)
        if (refusal) {
          return refusal
        }
        throw err
      }
      return {
        ok: true,
        message: 'Page created successfully.',
        page
      }
    }
  )

  /**
   * UPDATE PAGE
   */
  app.patch<{
    Params: { siteId: string; pageId: string }
    Body: Partial<PageInput> & {
      /**
       * The page's `updatedAt` as the editor last saw it. Checked against the stored value below —
       * see the optimistic-concurrency comment further down — rather than being passed into
       * `updatePage()`, since it describes the save's precondition rather than a field of the page.
       */
      expectedUpdatedAt?: string
    }
  }>(
    '/sites/:siteId/pages/:pageId',
    {
      /*
        No route-level `permissions`: that hook reads the group-wide list, and page permissions are
        granted by a group's RULES. Checked against the page in question below instead — which is
        also what lets a rule open one branch to somebody the group as a whole cannot write to.
      */
      schema: {
        summary: 'Update a page',
        description:
          'Accepts any subset of the fields. Sending `render` replaces the stored HTML, its table of contents and its search text; sending `content` without it leaves the previous render in place, which is what a source-only edit means.',
        tags: ['Pages'],
        params: { $ref: 'SitePageParams#' },
        body: { $ref: 'PageInput#' },
        response: {
          200: {
            description: 'Page updated successfully',
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              message: { type: 'string' },
              page: { $ref: 'Page#' },
              classificationConflicts: {
                type: 'array',
                description:
                  "Present only when this save raised the page's own classification and left one or more descendants below the new floor (OpenProject #1080) -- not cascaded automatically. Resolve via POST …/classification-conflicts/resolve.",
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', format: 'uuid' },
                    path: { type: 'string' },
                    title: { type: 'string' },
                    classification: { type: 'string', format: 'uuid' }
                  }
                }
              }
            }
          },
          400: {
            $ref: 'ApiError#',
            description:
              'The page has no server-side renderer for its editor, and this write carried content with no explicit render for it to fall back on.'
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' },
          409: {
            description:
              "The page changed since `expectedUpdatedAt` was read; the write was refused rather than overwriting somebody else's save.",
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              message: { type: 'string' },
              page: {
                type: 'object',
                description:
                  'The page as it is stored right now, for a diff or an overwrite prompt.',
                properties: {
                  updatedAt: { type: 'string', format: 'date-time' },
                  title: { type: 'string' },
                  content: { type: 'string' },
                  authorName: { type: 'string' }
                }
              }
            }
          },
          503: {
            $ref: 'ApiError#',
            description:
              'This write carried content with no explicit render, and the instance has no Puppeteer extension installed to produce one server-side.'
          }
        }
      }
    },
    async (req, reply) => {
      const actor = actorFrom(req)
      if (!actor) {
        return reply.unauthorized('Saving a page requires a logged in user.')
      }
      const target = await WIKI.models.pages.getPage({
        siteId: req.params.siteId,
        id: req.params.pageId,
        withContent: true
      })
      if (!target) {
        return reply.notFound('This page does not exist.')
      }
      if (!mayOnPage(req, 'write:pages', req.params.siteId, target)) {
        return reply.forbidden('You are not allowed to edit this page.')
      }
      /*
        Declassification guardrail (OpenProject #1080): lowering a page's classification (making it
        MORE open) is not covered by `write:pages`/`manage:pages` alone -- it needs `manage:classification`
        ON THIS PAGE too, so an editor who can write the page cannot silently declassify it by editing
        metadata. Raising it needs nothing beyond the ordinary write permission already checked above;
        the floor-invariant/level-exists validation itself happens in `updatePage()`.
      */
      if (
        req.body.classification !== undefined &&
        req.body.classification !== target.classification &&
        WIKI.models.classificationLevels.isLowerThan(
          req.body.classification,
          target.classification
        ) &&
        !mayOnPage(req, 'manage:classification', req.params.siteId, target)
      ) {
        return reply.forbidden(
          'Lowering this page’s classification requires the manage:classification permission on it.'
        )
      }
      /*
        Publish-state guardrail (OpenProject #2466, part of #2421's dedicated publish/unpublish
        permission): changing `publishState` is not covered by `write:pages`/`manage:pages` alone --
        it needs `publish:pages` ON THIS PAGE too, so an editor who can write the page cannot silently
        publish or unpublish it. Unlike the classification guardrail above, `publishState` has no
        "direction" to spare a raise from the extra check -- any actual change needs it.
      */
      if (
        req.body.publishState !== undefined &&
        req.body.publishState !== target.publishState &&
        !mayOnPage(req, 'publish:pages', req.params.siteId, target)
      ) {
        return reply.forbidden(
          'Changing this page’s publish state requires the publish:pages permission on it.'
        )
      }
      /*
        Optimistic concurrency: `expectedUpdatedAt` is the `updatedAt` the editor's save started from.
        A collab-connected editor's next save naturally carries the post-save timestamp its own
        collaborators' saves already advanced it to (`applySave()` in `composables/collab.js`), so this
        never false-positives against them — it only catches a save that began before somebody else's
        landed. Millisecond precision, since that is what the API hands back and what a client round-
        trips; comparing `Temporal.Instant` values directly with `<` throws, so this compares
        `epochMilliseconds` instead.
      */
      /*
        Escape-hatch guarantee (OpenProject #838, upstream requarks/wiki #2256): a 409 here is a
        REFUSAL, not a dead end. The response below always carries the row's current `updatedAt`,
        which is everything a caller needs to make its next request succeed — resubmit the same body
        with that value as `expectedUpdatedAt` and this check passes, because by then it once again
        matches what is stored. There is no state this route can put a page into where a save is
        permanently unsavable; a caller can always either adopt what's on the server or force its own
        content through as the new version. `PageSaveConflictDialog.vue` /
        `EditorMarkdown.vue#resolveSaveConflict` is the frontend consumer of that guarantee ("Save
        Anyway" issues exactly this resubmission); `pages.test.ts` proves the round trip end to end.
      */
      if (
        req.body.expectedUpdatedAt &&
        Temporal.Instant.from(req.body.expectedUpdatedAt).epochMilliseconds !==
          target.updatedAt.toTemporalInstant().epochMilliseconds
      ) {
        return reply.code(409).send({
          ok: false,
          message: 'This page was changed since you started editing it.',
          page: {
            updatedAt: target.updatedAt
              .toTemporalInstant()
              .toString({ smallestUnit: 'millisecond' }),
            title: target.title,
            content: target.content,
            authorName: target.authorName
          }
        })
      }
      let page
      try {
        page = await WIKI.models.pages.updatePage(
          req.params.siteId,
          req.params.pageId,
          req.body,
          actor
        )
      } catch (err: any) {
        const refusal = replyForRenderRefusal(err, reply)
        if (refusal) {
          return refusal
        }
        throw err
      }
      if (!page) {
        return reply.notFound('This page does not exist.')
      }
      /*
        Anyone else editing this page right now is looking at the text that was just stored, so their
        editor should stop calling it unsaved. Told through the collaboration room rather than answered
        here, since they are on their own requests — and, quite possibly, on another instance.
      */
      WIKI.collab.pageSaved(page.id, {
        versionDate: page.updatedAt.toTemporalInstant().toString({ smallestUnit: 'millisecond' }),
        authorId: actor.id,
        authorName: page.authorName ?? ''
      })
      await recordClassificationChange(
        req,
        req.params.siteId,
        page,
        target.classification,
        page.classification
      )
      /*
        Retroactive parent classification raise (OpenProject #1080): raising THIS page's own
        classification does not cascade to its descendants -- some may now sit below the new floor.
        Rather than silently leaving them there, or silently bumping them, this surfaces the list for
        an admin to resolve explicitly (`ClassificationResolutionDialog.vue`), via
        `POST …/classification-conflicts/resolve`. Only computed when the classification actually got
        stricter -- a lower/unchanged classification can only ever WIDEN what the old floor already
        permitted, so there is nothing new to surface.
      */
      const classificationConflicts =
        req.body.classification !== undefined &&
        req.body.classification !== target.classification &&
        WIKI.models.classificationLevels.isLowerThan(target.classification, req.body.classification)
          ? await WIKI.models.pageClassification.descendantsBelowFloor(
              req.params.siteId,
              page.locale,
              page.path,
              page.classification
            )
          : []
      return {
        ok: true,
        message: 'Page updated successfully.',
        page,
        ...(classificationConflicts.length > 0 ? { classificationConflicts } : {})
      }
    }
  )

  /**
   * MOVE / RENAME PAGE
   */
  app.put<{
    Params: { siteId: string; pageId: string }
    Body: { path: string; title?: string; locale?: string; includeTranslations?: boolean }
  }>(
    '/sites/:siteId/pages/:pageId/path',
    {
      /*
        No route-level `permissions`: that hook reads the group-wide list, and page permissions are
        granted by a group's RULES. Checked against the page in question below instead — which is
        also what lets a rule open one branch to somebody the group as a whole cannot write to.
      */
      schema: {
        summary: 'Move a page to another path',
        description:
          "Also renames it when a title is given, and re-homes it into another locale of the same site when one is given. The tree entry moves with it, and any folder the new path needs is created. A destination another page already occupies -- including one that wins a race against this same request -- answers `pageDuplicatePath` (409), the same JSON error shape every other page-creation failure uses, not a generic 500; a locale the site does not have enabled answers `pageInvalidLocale` (400).\n\nThe caller needs `manage:pages` on the page as it is now AND `write:pages` on where it is going -- the same destination check `POST .../deleted/:versionId/recover` makes, since arriving somewhere is a write there whether the page came from a fresh create or from moving out of another branch.\n\n`includeTranslations` cascades the path change to every other locale's page sharing this page's current path (its translations -- see docs/decisions/locale-translation-linking.md). All-or-nothing: the caller needs `manage:pages` on each twin's own path AND `write:pages` on the shared destination, and a 409 or 403 on any single translation aborts the whole batch, naming which locale it was.",
        tags: ['Pages'],
        params: { $ref: 'SitePageParams#' },
        body: {
          type: 'object',
          required: ['path'],
          properties: {
            path: {
              type: 'string',
              maxLength: 255,
              pattern: '^/?[a-zA-Z0-9-_/]*$'
            },
            title: {
              type: 'string',
              minLength: 1,
              maxLength: 255
            },
            locale: {
              type: 'string',
              maxLength: 10,
              description: 'Move the page into this locale. Unchanged when absent.'
            },
            includeTranslations: {
              type: 'boolean',
              description:
                "Move every other locale's page sharing this page's current path along with it. Ignored when the path is not actually changing -- a locale-only move has no translations to carry, since they are found by path."
            }
          }
        },
        response: {
          200: {
            description: 'Page moved successfully',
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              message: { type: 'string' },
              page: { $ref: 'Page#' }
            }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' },
          409: {
            $ref: 'ApiError#',
            description: 'A page already exists at the destination path (`pageDuplicatePath`).'
          }
        }
      }
    },
    async (req, reply) => {
      const actor = actorFrom(req)
      if (!actor) {
        return reply.unauthorized('Moving a page requires a logged in user.')
      }
      const target = await WIKI.models.pages.getPage({
        siteId: req.params.siteId,
        id: req.params.pageId
      })
      if (!target) {
        return reply.notFound('This page does not exist.')
      }
      if (!mayOnPage(req, 'manage:pages', req.params.siteId, target)) {
        return reply.forbidden('You are not allowed to move this page.')
      }
      // -> Where it is going is its own question: rules are matched on path AND locale, so being
      //    allowed to manage a page where it sits now says nothing about the destination. Checked
      //    against `write:pages`, not `manage:pages` -- the group editor's own hint for `manage:pages`
      //    promises "other locations the user has WRITE ACCESS to", and `write:pages` is exactly the
      //    permission `POST .../deleted/:versionId/recover` already checks against its own target
      //    path for the same reason: landing a page somewhere is a write there, whatever put it in
      //    motion (OpenProject #937). The ref carries the page's tags because they travel with it, so
      //    a rule that grants by tag applies at the destination exactly as it does at the source; the
      //    path is normalized the way `movePage` will store it, so that a leading slash in the body
      //    cannot make a rule miss.
      const destPath = normalizePagePath(req.body.path)
      const destLocale = req.body.locale ?? target.locale
      if (destPath !== target.path || destLocale !== target.locale) {
        const destRef = { path: destPath, locale: destLocale, tags: target.tags }
        if (!mayOnPage(req, 'write:pages', req.params.siteId, destRef)) {
          return reply.forbidden('You are not allowed to move this page there.')
        }
      }
      // -> `includeTranslations` cascades to every other locale's page sharing this page's CURRENT
      //    path -- checked here, before the model is asked to do anything, because a batch move is
      //    "everyone involved may go" or nothing: a rule that lets this caller manage `en` but not
      //    `fr` must not let them drag the `fr` translation along for the ride just because they may
      //    manage the primary page. Each twin still needs `manage:pages` to be moved away from its OWN
      //    path, same as the primary; the shared destination needs `write:pages`, same reasoning as
      //    above.
      if (req.body.includeTranslations && destPath !== target.path) {
        const translations = await WIKI.models.pages.getTranslations(
          req.params.siteId,
          target.path,
          target.id
        )
        for (const translation of translations) {
          const sourceRef = {
            path: translation.path,
            locale: translation.locale,
            tags: translation.tags
          }
          const destRef = { path: destPath, locale: translation.locale, tags: translation.tags }
          if (
            !mayOnPage(req, 'manage:pages', req.params.siteId, sourceRef) ||
            !mayOnPage(req, 'write:pages', req.params.siteId, destRef)
          ) {
            return reply.forbidden(
              `You are not allowed to move the "${translation.locale}" translation of this page.`
            )
          }
        }
      }
      const page = await WIKI.models.pages.movePage(
        req.params.siteId,
        req.params.pageId,
        req.body,
        actor
      )
      if (!page) {
        return reply.notFound('This page does not exist.')
      }
      // -> Only ever fires from the floor-invariant auto-bump (OpenProject #1080): an ordinary move
      //    (or a title/locale-only one) never touches classification, so `from === to` there and
      //    `recordClassificationChange` is a no-op. Covers the primary page only -- `movePage()`
      //    returns just that one, not an `includeTranslations` twin also auto-bumped in the same
      //    call, so a twin's own bump goes unlogged here. Narrow, documented gap rather than
      //    threading the whole batch back out through the model for this alone.
      await recordClassificationChange(
        req,
        req.params.siteId,
        page,
        target.classification,
        page.classification
      )
      return {
        ok: true,
        message: 'Page moved successfully.',
        page
      }
    }
  )

  /**
   * RE-RENDER PAGE
   */
  app.post<{ Params: { siteId: string; pageId: string } }>(
    '/sites/:siteId/pages/:pageId/render',
    {
      /*
        No route-level `permissions`: that hook reads the group-wide list, and page permissions are
        granted by a group's RULES. Checked against the page in question below instead — which is
        also what lets a rule open one branch to somebody the group as a whole cannot write to.
      */
      // -> Bounds how fast one client can fill the queue; see `helpers/rateLimit.ts`
      preHandler: limitRenders,
      schema: {
        summary: 'Queue a page to be rendered again from its source',
        description:
          'For when a stored render has gone stale and nobody has the page open to re-save it. The markdown pipeline lives in the frontend, so the server drives it in a headless browser and the result matches what the editor would produce — which means this needs the Puppeteer extension, and answers 503 without it.\n\nAnswers 202: a browser is far too heavy to hold a request open for, so the page joins a queue that is drained one page at a time and its render is replaced when its turn comes. Asking twice for the same page is one render of whatever the content has become by then. Rate limited, to bound how fast the queue can be filled.',
        tags: ['Pages'],
        params: { $ref: 'SitePageParams#' },
        response: {
          202: {
            description: 'Page queued for rendering',
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              message: { type: 'string' }
            }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const actor = actorFrom(req)
      if (!actor) {
        return reply.unauthorized('Rendering a page requires a logged in user.')
      }
      const target = await WIKI.models.pages.getPage({
        siteId: req.params.siteId,
        id: req.params.pageId
      })
      if (!target) {
        return reply.notFound('This page does not exist.')
      }
      // -> Rewrites what the page shows, so it is an edit and takes the same permission as one
      if (!mayOnPage(req, 'write:pages', req.params.siteId, target)) {
        return reply.forbidden('You are not allowed to edit this page.')
      }
      const queued = await WIKI.models.pages.queueRerender(
        req.params.siteId,
        req.params.pageId,
        actor
      )
      if (!queued) {
        return reply.notFound('This page does not exist.')
      }
      return reply.code(202).send({
        ok: true,
        message: 'Page queued for rendering.'
      })
    }
  )

  /**
   * BULK ACTION (OpenProject #1882)
   *
   * The row-selection/bulk-actions half of the admin page inventory: delete, re-render or retag a
   * set of pages in one request. Each id is checked and acted on independently — a page the caller
   * may not act on is reported as `skipped` rather than failing the whole batch, which is the
   * opposite of `POST …/classification-conflicts/resolve` just above (that route `forbidden()`s the
   * entire request on the first denied page). Both are correct for what each one is: the
   * classification-conflicts flow is a single all-or-nothing bump an admin already knows they may
   * make on every listed descendant, while a bulk action here starts from an arbitrary, admin-picked
   * selection that may well mix pages the actor can and cannot act on — the whole point of reporting
   * per-page outcomes instead of refusing outright.
   *
   * Retag is add/remove-RELATIVE per page, not a blanket overwrite: a mixed selection can carry
   * different existing tag sets, so "add x, remove y" is applied against each page's own tags rather
   * than a client-supplied full list clobbering whatever else a page already carried.
   */
  app.post<{
    Params: { siteId: string }
    Body: {
      pageIds: string[]
      action: 'delete' | 'render' | 'retag'
      addTags?: string[]
      removeTags?: string[]
    }
  }>(
    '/sites/:siteId/pages/bulk',
    {
      // -> No route-level `permissions`: page-rule permissions, checked per page below.
      // -> Only the `render` action drives Puppeteer; the same throttle the single-page render route
      //    uses, since a bulk request can still queue many browser renders from one call.
      preHandler: async (req, reply) => {
        if ((req.body as { action?: string } | undefined)?.action === 'render') {
          await limitRenders(req, reply)
        }
      },
      schema: {
        summary: 'Delete, re-render or retag a set of pages',
        description:
          "For the admin page inventory's row selection. Every id is looked up and permission-checked on its own — `delete:pages` for `delete`, `write:pages` for `render`/`retag` — so a page the caller may not act on is reported back as `skipped` rather than refusing the whole request. An id that does not exist on this site comes back `notFound`; an action that threw while running (e.g. re-rendering a page this instance cannot render) comes back `error` with its message. `retag` needs at least one of `addTags`/`removeTags`, applied against each page's own existing tags rather than replacing them outright.",
        tags: ['Pages'],
        params: { $ref: 'SiteIdParams#' },
        body: {
          type: 'object',
          required: ['pageIds', 'action'],
          properties: {
            pageIds: {
              type: 'array',
              items: { type: 'string', format: 'uuid' },
              minItems: 1,
              maxItems: 500
            },
            action: {
              type: 'string',
              enum: ['delete', 'render', 'retag']
            },
            addTags: {
              type: 'array',
              items: { type: 'string', maxLength: 255 },
              maxItems: 100,
              description: '`retag` only: tags to add to every page that is not skipped.'
            },
            removeTags: {
              type: 'array',
              items: { type: 'string', maxLength: 255 },
              maxItems: 100,
              description: '`retag` only: tags to remove from every page that is not skipped.'
            }
          }
        },
        response: {
          200: {
            description: 'Every id, with what happened to it',
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              action: { type: 'string' },
              results: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', format: 'uuid' },
                    path: { type: ['string', 'null'] },
                    status: {
                      type: 'string',
                      enum: ['done', 'skipped', 'notFound', 'error']
                    },
                    message: { type: 'string' }
                  }
                }
              },
              counts: {
                type: 'object',
                description: 'How many ids landed in each `status`, keyed the same way.',
                additionalProperties: { type: 'integer' }
              }
            }
          },
          400: { $ref: 'ApiError#' },
          401: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const actor = actorFrom(req)
      if (!actor) {
        return reply.unauthorized('A bulk page action requires a logged in user.')
      }
      const { action } = req.body
      const addTags = (req.body.addTags ?? []).map((t) => t.trim()).filter(Boolean)
      const removeTags = (req.body.removeTags ?? []).map((t) => t.trim()).filter(Boolean)
      if (action === 'retag' && addTags.length < 1 && removeTags.length < 1) {
        return reply.badRequest('Provide at least one tag to add or remove.')
      }
      // -> De-duplicated, same reasoning as the classification-conflicts-resolve route just above: a
      //    repeated id would otherwise be looked up, permission-checked and acted on once per
      //    occurrence instead of once per page.
      const pageIds = [...new Set(req.body.pageIds)]
      // -> ONE batched select instead of a per-id `getPage` loop -- the same `getPagesByIds` the
      //    classification-conflicts-resolve route already uses, projecting only what `mayOnPage`
      //    (and, for `retag`, the page's own current tags) actually needs.
      const pageMap = await WIKI.models.pages.getPagesByIds(req.params.siteId, pageIds)
      const permission = action === 'delete' ? 'delete:pages' : 'write:pages'
      const results: {
        id: string
        path: string | null
        status: 'done' | 'skipped' | 'notFound' | 'error'
        message?: string
      }[] = []
      for (const pageId of pageIds) {
        const target = pageMap.get(pageId)
        if (!target) {
          results.push({ id: pageId, path: null, status: 'notFound' })
          continue
        }
        if (!mayOnPage(req, permission, req.params.siteId, target)) {
          results.push({
            id: pageId,
            path: target.path,
            status: 'skipped',
            message: 'Not permitted.'
          })
          continue
        }
        try {
          if (action === 'delete') {
            const deleted = await WIKI.models.pages.deletePage(req.params.siteId, pageId, actor)
            results.push({
              id: pageId,
              path: target.path,
              status: deleted ? 'done' : 'notFound'
            })
          } else if (action === 'render') {
            const queued = await WIKI.models.pages.queueRerender(req.params.siteId, pageId, actor)
            results.push({
              id: pageId,
              path: target.path,
              status: queued ? 'done' : 'notFound'
            })
          } else {
            const removeSet = new Set(removeTags)
            const nextTags = [
              ...new Set([...target.tags.filter((t) => !removeSet.has(t)), ...addTags])
            ]
            const updated = await WIKI.models.pages.updatePage(
              req.params.siteId,
              pageId,
              { tags: nextTags },
              actor
            )
            results.push({
              id: pageId,
              path: target.path,
              status: updated ? 'done' : 'notFound'
            })
          }
        } catch (err: any) {
          results.push({ id: pageId, path: target.path, status: 'error', message: err.message })
        }
      }
      const counts: Record<string, number> = {}
      for (const result of results) {
        counts[result.status] = (counts[result.status] ?? 0) + 1
      }
      return { ok: true, action, results, counts }
    }
  )

  /**
   * DELETE PAGE
   */
  app.delete<{ Params: { siteId: string; pageId: string } }>(
    '/sites/:siteId/pages/:pageId',
    {
      /*
        No route-level `permissions`: that hook reads the group-wide list, and page permissions are
        granted by a group's RULES. Checked against the page in question below instead — which is
        also what lets a rule open one branch to somebody the group as a whole cannot write to.
      */
      schema: {
        summary: 'Delete a page',
        tags: ['Pages'],
        params: { $ref: 'SitePageParams#' },
        response: {
          204: {
            description: 'Page deleted successfully'
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const actor = actorFrom(req)
      if (!actor) {
        return reply.unauthorized('Deleting a page requires a logged in user.')
      }
      const target = await WIKI.models.pages.getPage({
        siteId: req.params.siteId,
        id: req.params.pageId
      })
      if (!target) {
        return reply.notFound('This page does not exist.')
      }
      if (!mayOnPage(req, 'delete:pages', req.params.siteId, target)) {
        return reply.forbidden('You are not allowed to delete this page.')
      }
      if (!(await WIKI.models.pages.deletePage(req.params.siteId, req.params.pageId, actor))) {
        return reply.notFound('This page does not exist.')
      }
      return reply.code(204).send()
    }
  )
}

export default routes
