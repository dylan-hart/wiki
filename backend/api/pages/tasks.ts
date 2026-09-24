import * as cheerio from 'cheerio'
import type { FastifyInstance } from 'fastify'
import { actorFrom, requireReadablePage } from '../../helpers/pageAccess.ts'
import { parseTaskItems, setTaskItem } from '../../helpers/taskItems.ts'

const CHECKBOX = 'input.task-list-item-checkbox'

function millisecondsOf(date: Date): string {
  return date.toTemporalInstant().toString({ smallestUnit: 'millisecond' })
}

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;')
}

/**
 * The stored render with the `index`th checkbox's `checked` set, and every other byte as it was:
 * only that one `<input>` tag is rewritten, from its own parsed attributes, so nothing else in the
 * render is re-parsed or re-serialized on the way back into the row. `null` when the render does not
 * hold `expected` checkboxes, i.e. no longer matches its source.
 */
function withCheckbox(
  render: string,
  index: number,
  checked: boolean,
  expected: number
): string | null {
  const $ = cheerio.load(
    render,
    { xml: { xmlMode: false, withStartIndices: true, withEndIndices: true } },
    false
  )
  const boxes = $(CHECKBOX)
  if (boxes.length !== expected) {
    return null
  }
  const box = boxes.get(index)
  if (!box || box.startIndex === null || box.endIndex === null) {
    return null
  }
  const attribs = { ...box.attribs }
  delete attribs.checked
  if (checked) {
    attribs.checked = ''
  }
  const tag = `<input${Object.entries(attribs)
    .map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
    .join('')}>`
  return render.slice(0, box.startIndex) + tag + render.slice(box.endIndex + 1)
}

async function routes(app: FastifyInstance) {
  app.put<{
    Params: { siteId: string; pageId: string; index: number }
    Body: { checked: boolean; text: string; expectedUpdatedAt: string }
  }>(
    '/sites/:siteId/pages/:pageId/tasks/:index',
    {
      // -> No route-level `permissions`: page-rule permissions, checked in the handler.
      schema: {
        summary: 'Tick or untick one task item of a page',
        description:
          'Flips the marker of the `index`th `- [ ]` / `- [x]` item of the page source (document order, code blocks excluded) and the matching checkbox of the stored render, and nothing else. The stored render is patched in place, not re-rendered or re-sanitized, so an embed its author was permitted survives a tick by someone who is not, and no re-render is queued. `text` is the item’s source text after the marker; a different text at that ordinal, or an `expectedUpdatedAt` older than the page (a concurrent save landing between this request’s read and its write included), answers 409 with the current `updatedAt`, so the caller can reload and retry.',
        tags: ['Pages'],
        params: {
          type: 'object',
          properties: {
            siteId: { type: 'string', format: 'uuid' },
            pageId: { type: 'string', format: 'uuid' },
            index: { type: 'integer', minimum: 0 }
          },
          required: ['siteId', 'pageId', 'index']
        },
        body: {
          type: 'object',
          required: ['checked', 'text', 'expectedUpdatedAt'],
          properties: {
            checked: { type: 'boolean' },
            text: { type: 'string', maxLength: 100000 },
            expectedUpdatedAt: { type: 'string', format: 'date-time' }
          },
          additionalProperties: false
        },
        response: {
          200: {
            description: 'Task item updated',
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              message: { type: 'string' },
              updatedAt: { type: 'string', format: 'date-time' }
            }
          },
          400: { $ref: 'ApiError#' },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' },
          409: {
            description:
              'The page changed since `expectedUpdatedAt`, or the item at `index` is no longer `text`.',
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              message: { type: 'string' },
              updatedAt: { type: 'string', format: 'date-time' }
            }
          }
        }
      }
    },
    async (req, reply) => {
      const actor = actorFrom(req)
      if (!actor) {
        return reply.unauthorized('Ticking a task requires a logged in user.')
      }
      const page = await requireReadablePage(req, reply, req.params.siteId, req.params.pageId, {
        permission: 'write:pages',
        forbiddenMessage: 'You are not allowed to edit this page.',
        withContent: true
      })
      if (!page) {
        return reply
      }
      const conflict = (message: string) =>
        reply.code(409).send({ ok: false, message, updatedAt: millisecondsOf(page.updatedAt) })

      if (page.contentType !== 'markdown' || typeof page.content !== 'string') {
        return reply.badRequest('This page is not written in markdown.')
      }
      if (
        Temporal.Instant.from(req.body.expectedUpdatedAt).epochMilliseconds !==
        page.updatedAt.toTemporalInstant().epochMilliseconds
      ) {
        return conflict('This page was changed since you loaded it.')
      }
      const { index } = req.params
      const { checked, text } = req.body
      const content = setTaskItem(page.content, index, text, checked)
      if (content === null) {
        return conflict('This task is no longer on the page as you saw it.')
      }
      if (content === page.content) {
        return {
          ok: true,
          message: 'Task already up to date.',
          updatedAt: millisecondsOf(page.updatedAt)
        }
      }

      const render = withCheckbox(
        page.render ?? '',
        index,
        checked,
        parseTaskItems(page.content).length
      )
      if (render === null) {
        return conflict('The rendered page no longer matches its source.')
      }

      let updated
      try {
        updated = await CARDINAL.models.pages.updatePage(
          req.params.siteId,
          req.params.pageId,
          { content, render },
          actor,
          // -> The render is the stored one with a checkbox flipped: sanitizing it again against the
          //    ticker's own write:scripts/write:styles would strip what its author was allowed. And
          //    the write lands only if the page is still the one `content` was computed from.
          { storedRenderPatch: true, expectedUpdatedAt: page.updatedAt }
        )
      } catch (err: any) {
        if (err?.name !== 'pageChangedSinceLoad') {
          throw err
        }
        const current = await CARDINAL.models.pages.getPage({
          siteId: req.params.siteId,
          id: req.params.pageId
        })
        return reply.code(409).send({
          ok: false,
          message: err.message,
          updatedAt: millisecondsOf(current?.updatedAt ?? page.updatedAt)
        })
      }
      if (!updated) {
        return reply.notFound('This page does not exist.')
      }
      CARDINAL.collab.pageSaved(updated.id, {
        versionDate: millisecondsOf(updated.updatedAt),
        authorId: actor.id,
        authorName: updated.authorName ?? ''
      })
      return { ok: true, message: 'Task updated.', updatedAt: millisecondsOf(updated.updatedAt) }
    }
  )
}

export default routes
