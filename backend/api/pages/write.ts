import type { FastifyInstance, FastifyReply } from 'fastify'
import type { PageInput } from '../../models/pages.ts'
import { CustomError, normalizePagePath } from '../../helpers/common.ts'
import { defaultLocale } from '../../helpers/localeRouting.ts'
import { limitRenders } from '../../helpers/rateLimit.ts'
import { actorFrom, mayOnPage } from '../../helpers/pageAccess.ts'
import { recordClassificationChange } from './classification.ts'

function tagSetChanged(current: string[], next: string[]): boolean {
  const currentSet = new Set(current)
  const nextSet = new Set(next)
  if (currentSet.size !== nextSet.size) {
    return true
  }
  return [...nextSet].some((tag) => !currentSet.has(tag))
}

/**
 * `ensureCanRender()` (`models/renderQueue.ts`) throws these two named errors when a write carries
 * content with no render and the server cannot produce one. `null` means the caller rethrows.
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

async function routes(app: FastifyInstance) {
  app.post<{ Params: { siteId: string }; Body: PageInput }>(
    '/sites/:siteId/pages',
    {
      // -> No route-level `permissions`: page-rule permissions, checked in the handler.
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
      const actor = actorFrom(req)
      if (!actor) {
        return reply.unauthorized('Saving a page requires a logged in user.')
      }
      // -> No page row exists yet, so `classification` stays unset and matches no CLASSIFICATION
      //    rule. `tags` come from the body, so a TAG/TAGALL rule is judged on the page as it is
      //    about to become.
      const createPageRef = {
        path: req.body.path,
        locale: req.body.locale ?? defaultLocale(req.params.siteId),
        tags: req.body.tags
      }
      if (!mayOnPage(req, 'write:pages', req.params.siteId, createPageRef)) {
        return reply.forbidden('You are not allowed to create a page here.')
      }
      // -> `createPage()` defaults an omitted `publishState` to `'published'`, so omitting it needs
      //    `publish:pages` too; `write:pages` never implies it.
      if (
        (req.body.publishState ?? 'published') === 'published' &&
        !mayOnPage(req, 'publish:pages', req.params.siteId, createPageRef)
      ) {
        return reply.forbidden(
          'Publishing a page immediately requires the publish:pages permission here.'
        )
      }
      if (
        (req.body.scriptJsLoad !== undefined || req.body.scriptJsUnload !== undefined) &&
        !mayOnPage(req, 'write:scripts', req.params.siteId, createPageRef)
      ) {
        return reply.forbidden(
          'Setting this page’s load/unload scripts requires the write:scripts permission here.'
        )
      }
      if (
        req.body.scriptCss !== undefined &&
        !mayOnPage(req, 'write:styles', req.params.siteId, createPageRef)
      ) {
        return reply.forbidden(
          'Setting this page’s styles requires the write:styles permission here.'
        )
      }
      let page
      try {
        page = await CARDINAL.models.pages.createPage(req.params.siteId, req.body, actor)
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

  app.patch<{
    Params: { siteId: string; pageId: string }
    Body: Partial<PageInput> & {
      /** The page's `updatedAt` as the editor last saw it: the save's precondition, not a field. */
      expectedUpdatedAt?: string
    }
  }>(
    '/sites/:siteId/pages/:pageId',
    {
      // -> No route-level `permissions`: page-rule permissions, checked in the handler.
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
      const target = await CARDINAL.models.pages.getPage({
        siteId: req.params.siteId,
        id: req.params.pageId,
        withContent: true
      })
      if (!target) {
        return reply.notFound('This page does not exist.')
      }
      /*
        `publishState` is carved out of the write gate in both directions: a `publish:pages` holder
        with no `write:pages` may change it, but only when the body touches nothing else; and
        `write:pages` alone never may.
      */
      const hasWrite = mayOnPage(req, 'write:pages', req.params.siteId, target)
      if (!hasWrite) {
        const bodyTouchesOnlyPublishState = Object.keys(req.body).every(
          (key) => key === 'publishState' || key === 'expectedUpdatedAt'
        )
        if (
          !bodyTouchesOnlyPublishState ||
          !mayOnPage(req, 'publish:pages', req.params.siteId, target)
        ) {
          return reply.forbidden('You are not allowed to edit this page.')
        }
      }
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
        Lowering a classification (making the page MORE open) needs `manage:classification` on top
        of the write permission, so an editor cannot declassify a page by editing its metadata.
        Raising it needs nothing more; `updatePage()` validates the floor and that the level exists.
      */
      if (
        req.body.classification !== undefined &&
        req.body.classification !== target.classification &&
        CARDINAL.models.classificationLevels.isLowerThan(
          req.body.classification,
          target.classification
        ) &&
        !mayOnPage(req, 'manage:classification', req.params.siteId, target)
      ) {
        return reply.forbidden(
          'Lowering this page’s classification requires the manage:classification permission on it.'
        )
      }
      // -> Only an actual change needs the permission: every ordinary save resubmits the page's
      //    current scripts and styles unchanged.
      if (
        ((req.body.scriptJsLoad !== undefined && req.body.scriptJsLoad !== target.scriptJsLoad) ||
          (req.body.scriptJsUnload !== undefined &&
            req.body.scriptJsUnload !== target.scriptJsUnload)) &&
        !mayOnPage(req, 'write:scripts', req.params.siteId, target)
      ) {
        return reply.forbidden(
          'Changing this page’s load/unload scripts requires the write:scripts permission on it.'
        )
      }
      if (
        req.body.scriptCss !== undefined &&
        req.body.scriptCss !== target.scriptCss &&
        !mayOnPage(req, 'write:styles', req.params.siteId, target)
      ) {
        return reply.forbidden(
          'Changing this page’s styles requires the write:styles permission on it.'
        )
      }
      /*
        `hasWrite` judged the page with its current tags. A tag change also needs `write:pages` on
        the page as it leaves, or an editor could tag a page into a branch a tag-scoped rule
        protects, or untag it out from under that rule's DENY.
      */
      if (req.body.tags !== undefined && tagSetChanged(target.tags, req.body.tags)) {
        const postChangeRef = {
          path: target.path,
          locale: target.locale,
          tags: req.body.tags,
          classification: target.classification
        }
        if (!mayOnPage(req, 'write:pages', req.params.siteId, postChangeRef)) {
          return reply.forbidden('You are not allowed to change this page’s tags to that set.')
        }
        /*
          A tag rule can outrank a path rule, so whoever edits tags can widen or narrow access
          through them alone. `write:pages` proves write standing, not authority to retag:
          `write:tags` is needed on both the current and the resulting tag set.
        */
        if (
          !mayOnPage(req, 'write:tags', req.params.siteId, target) ||
          !mayOnPage(req, 'write:tags', req.params.siteId, postChangeRef)
        ) {
          return reply.forbidden('You are not allowed to change this page’s tags to that set.')
        }
      }
      /*
        Optimistic concurrency: refuses a save that began before somebody else's landed. Compared at
        millisecond precision, which is what the API hands back and a client round-trips. The 409
        carries the current `updatedAt`, so resubmitting with it as `expectedUpdatedAt` always gets
        through -- a conflict is never a dead end (upstream requarks/wiki #2256).
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
        page = await CARDINAL.models.pages.updatePage(
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
        Anyone else editing this page is looking at the text just stored, so their editor should
        stop calling it unsaved. They are on their own requests, possibly on another instance, hence
        the collaboration room.
      */
      CARDINAL.collab.pageSaved(page.id, {
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
        Raising a page's classification does not cascade, so descendants may now sit below the new
        floor. They are returned for an admin to resolve explicitly rather than silently bumped;
        only a stricter classification can produce any.
      */
      const classificationConflicts =
        req.body.classification !== undefined &&
        req.body.classification !== target.classification &&
        CARDINAL.models.classificationLevels.isLowerThan(
          target.classification,
          req.body.classification
        )
          ? await CARDINAL.models.pageClassification.descendantsBelowFloor(
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

  app.put<{
    Params: { siteId: string; pageId: string }
    Body: { path: string; title?: string; locale?: string; includeTranslations?: boolean }
  }>(
    '/sites/:siteId/pages/:pageId/path',
    {
      // -> No route-level `permissions`: page-rule permissions, checked in the handler.
      schema: {
        summary: 'Move a page to another path',
        description:
          "Also renames it when a title is given, and re-homes it into another locale of the same site when one is given. The tree entry moves with it, and any folder the new path needs is created. A destination another page already occupies -- including one that wins a race against this same request -- answers `pageDuplicatePath` (409), the same JSON error shape every other page-creation failure uses, not a generic 500; a locale the site does not have enabled answers `pageInvalidLocale` (400).\n\nThe caller needs `manage:pages` on the page as it is now AND `write:pages` on where it is going -- the same destination check `POST .../deleted/:versionId/recover` makes, since arriving somewhere is a write there whether the page came from a fresh create or from moving out of another branch.\n\n`includeTranslations` cascades the path change to every other locale's page sharing this page's current path (its translations). All-or-nothing: the caller needs `manage:pages` on each twin's own path AND `write:pages` on the shared destination, and a 409 or 403 on any single translation aborts the whole batch, naming which locale it was.",
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
      const target = await CARDINAL.models.pages.getPage({
        siteId: req.params.siteId,
        id: req.params.pageId
      })
      if (!target) {
        return reply.notFound('This page does not exist.')
      }
      if (!mayOnPage(req, 'manage:pages', req.params.siteId, target)) {
        return reply.forbidden('You are not allowed to move this page.')
      }
      // -> The destination is its own question: rules match on path AND locale, and landing a page
      //    somewhere is a write there, hence `write:pages` rather than `manage:pages`. Tags travel
      //    with the page; the path is normalized as `movePage` stores it, so a leading slash in the
      //    body cannot make a rule miss.
      const destPath = normalizePagePath(req.body.path)
      const destLocale = req.body.locale ?? target.locale
      if (destPath !== target.path || destLocale !== target.locale) {
        const destRef = { path: destPath, locale: destLocale, tags: target.tags }
        if (!mayOnPage(req, 'write:pages', req.params.siteId, destRef)) {
          return reply.forbidden('You are not allowed to move this page there.')
        }
      }
      // -> All-or-nothing, checked before the model moves anything: being allowed to manage the
      //    `en` page must not drag along an `fr` translation the caller may not manage.
      if (req.body.includeTranslations && destPath !== target.path) {
        const translations = await CARDINAL.models.pages.getTranslations(
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
      const page = await CARDINAL.models.pages.movePage(
        req.params.siteId,
        req.params.pageId,
        req.body,
        actor
      )
      if (!page) {
        return reply.notFound('This page does not exist.')
      }
      // -> Only a move under a stricter parent changes a classification (the floor auto-bump).
      //    Known gap: `movePage()` returns the primary page alone, so an `includeTranslations`
      //    twin's own bump goes unlogged.
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

  app.put<{
    Params: { siteId: string; pageId: string }
    Body: { editor: string }
  }>(
    '/sites/:siteId/pages/:pageId/editor',
    {
      // -> No route-level `permissions`: page-rule permissions, checked in the handler.
      schema: {
        summary: 'Convert a page between its markdown and wysiwyg editors',
        description:
          "Flips which editor a page opens in, between `markdown` and `wysiwyg` — the pair that share `'markdown'` storage (OpenProject #3395), so this relabels the row rather than rewriting its content. The caller is trusted to have already run the render-equality check (`PageConvertDialog.vue`, in the browser, against the site's own markdown renderer) before calling this — the server re-checks only that the row is still in a convertible state, not that the conversion is lossless.",
        tags: ['Pages'],
        params: { $ref: 'SitePageParams#' },
        body: {
          type: 'object',
          required: ['editor'],
          properties: {
            editor: { type: 'string', enum: ['markdown', 'wysiwyg'] }
          }
        },
        response: {
          200: {
            description: 'Page editor converted successfully',
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
              'Either editor named isn’t `markdown`/`wysiwyg`, the page already uses the target editor, or the page has not yet been saved through the #3395/#3400 markdown migration.'
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
        return reply.unauthorized('Converting a page’s editor requires a logged in user.')
      }
      const target = await CARDINAL.models.pages.getPage({
        siteId: req.params.siteId,
        id: req.params.pageId
      })
      if (!target) {
        return reply.notFound('This page does not exist.')
      }
      if (!mayOnPage(req, 'write:pages', req.params.siteId, target)) {
        return reply.forbidden('You are not allowed to edit this page.')
      }
      const page = await CARDINAL.models.pages.convertEditor(
        req.params.siteId,
        req.params.pageId,
        req.body.editor,
        actor
      )
      if (!page) {
        return reply.notFound('This page does not exist.')
      }
      return {
        ok: true,
        message: 'Page editor converted successfully.',
        page
      }
    }
  )

  app.post<{ Params: { siteId: string; pageId: string } }>(
    '/sites/:siteId/pages/:pageId/render',
    {
      // -> No route-level `permissions`: page-rule permissions, checked in the handler.
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
      const target = await CARDINAL.models.pages.getPage({
        siteId: req.params.siteId,
        id: req.params.pageId
      })
      if (!target) {
        return reply.notFound('This page does not exist.')
      }
      if (!mayOnPage(req, 'write:pages', req.params.siteId, target)) {
        return reply.forbidden('You are not allowed to edit this page.')
      }
      const queued = await CARDINAL.models.pages.queueRerender(
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
      // -> Only `render` drives Puppeteer, so only it takes the render route's throttle.
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
      const pageIds = [...new Set(req.body.pageIds)]
      const pageMap = await CARDINAL.models.pages.getPagesByIds(req.params.siteId, pageIds)
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
            const deleted = await CARDINAL.models.pages.deletePage(req.params.siteId, pageId, actor)
            results.push({
              id: pageId,
              path: target.path,
              status: deleted ? 'done' : 'notFound'
            })
          } else if (action === 'render') {
            const queued = await CARDINAL.models.pages.queueRerender(
              req.params.siteId,
              pageId,
              actor
            )
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
            // -> The PATCH route's retag checks, per page. A refusal is `skipped`, not `error`: a
            //    permission outcome, not a failure while acting.
            if (tagSetChanged(target.tags, nextTags)) {
              const postChangeRef = {
                path: target.path,
                locale: target.locale,
                tags: nextTags,
                classification: target.classification
              }
              if (!mayOnPage(req, 'write:pages', req.params.siteId, postChangeRef)) {
                results.push({
                  id: pageId,
                  path: target.path,
                  status: 'skipped',
                  message: 'Not permitted for the resulting tags.'
                })
                continue
              }
              if (
                !mayOnPage(req, 'write:tags', req.params.siteId, target) ||
                !mayOnPage(req, 'write:tags', req.params.siteId, postChangeRef)
              ) {
                results.push({
                  id: pageId,
                  path: target.path,
                  status: 'skipped',
                  message: 'Not permitted for the resulting tags.'
                })
                continue
              }
            }
            const updated = await CARDINAL.models.pages.updatePage(
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

  app.delete<{ Params: { siteId: string; pageId: string } }>(
    '/sites/:siteId/pages/:pageId',
    {
      // -> No route-level `permissions`: page-rule permissions, checked in the handler.
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
      const target = await CARDINAL.models.pages.getPage({
        siteId: req.params.siteId,
        id: req.params.pageId
      })
      if (!target) {
        return reply.notFound('This page does not exist.')
      }
      if (!mayOnPage(req, 'delete:pages', req.params.siteId, target)) {
        return reply.forbidden('You are not allowed to delete this page.')
      }
      if (!(await CARDINAL.models.pages.deletePage(req.params.siteId, req.params.pageId, actor))) {
        return reply.notFound('This page does not exist.')
      }
      return reply.code(204).send()
    }
  )
}

export default routes
