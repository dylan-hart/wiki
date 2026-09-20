import fastifyMultipart from '@fastify/multipart'
import { extractBlockDefinition, extractDefinedElementTag } from '../helpers/blockDefinition.ts'
import { CustomError } from '../helpers/common.ts'
import { limitUploads } from '../helpers/rateLimit.ts'
import { maySiteAdmin } from '../helpers/siteRules.ts'
import type { FastifyInstance, FastifyRequest } from 'fastify'

/**
 * Group-wide permissions only. `write:pages` does not belong here: page permissions come from a
 * group's rules, which `mayListBlocks` reads separately.
 */
const LIST_PERMISSIONS = ['manage:sites', 'manage:system']

const AUTHOR_ROLES = ['write:pages', 'manage:pages']

/**
 * The list feeds the editor's block picker, so it goes to whoever may put a block into a page: an
 * administrator, an author (any page rule granting an author role), or anyone an enabled approval
 * rule lets suggest an edit — guests included, since a suggestion is written in the same editor.
 * Path-blind on purpose: nothing in the reply is page-specific.
 */
async function mayListBlocks(req: FastifyRequest, siteId: string): Promise<boolean> {
  const actor = CARDINAL.models.groups.actorForRequest(req)
  if (LIST_PERMISSIONS.some((permission) => actor.permissions.includes(permission))) {
    return true
  }
  if (
    CARDINAL.models.groups
      .rulesForGroups(actor.groupIds)
      .some(
        (rule) => rule.mode !== 'DENY' && AUTHOR_ROLES.some((role) => rule.roles?.includes(role))
      )
  ) {
    return true
  }
  const groupIds = CARDINAL.models.approvals.getActorGroupIds(req)
  const rules = await CARDINAL.models.approvalRules.getRules(siteId)
  return rules.some(
    (rule) => rule.isEnabled && rule.submitterGroups.some((id) => groupIds.includes(id))
  )
}

async function routes(app: FastifyInstance) {
  // -> A single upload is the raw `component.js` source. `'*'` only claims content types no other
  //    parser here does, so the JSON routes are unaffected, and it is scoped to this plugin.
  app.addContentTypeParser(
    '*',
    { parseAs: 'buffer', bodyLimit: CARDINAL.config.security?.uploadMaxFileSize ?? 10485760 },
    (req, body, done) => {
      done(null, body)
    }
  )

  // -> For the batch route. Fastify matches `multipart/form-data` ahead of the `'*'` parser above
  //    regardless of registration order. Exceeding `files` raises `FST_FILES_LIMIT` while iterating
  //    `req.parts()`, before the extra file is read into memory. `throwFileSizeLimit: false` so an
  //    oversized file fails only its own entry (`part.file.truncated`), not the whole batch.
  await app.register(fastifyMultipart, {
    limits: {
      fileSize: CARDINAL.config.security?.uploadMaxFileSize ?? 10485760,
      files: CARDINAL.config.security?.uploadMaxFilesPerBatch ?? 10
    },
    throwFileSizeLimit: false
  })

  app.get<{ Params: { siteId: string } }>(
    '/sites/:siteId/blocks',
    {
      /*
        No route-level `permissions`: who may see this list comes down to a group's rules, which that
        hook does not read — and it would refuse the anonymous reader a wiki taking public
        suggestions has invited to use the picker. See `mayListBlocks`.
      */
      schema: {
        summary: 'List the blocks available to a site',
        description:
          'Built-in blocks are registered from the compiled block manifest, so the list reflects what is actually installed. This is what the editor builds its block picker from, so it is available to page authors and to anyone an approval rule lets suggest an edit — guests included, where a site takes public suggestions — as well as to site administrators.',
        tags: ['Blocks'],
        params: { $ref: 'SiteIdParams#' },
        response: {
          200: {
            description: 'List of site blocks',
            type: 'array',
            items: { $ref: 'Block#' }
          },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      if (!(await mayListBlocks(req, req.params.siteId))) {
        return reply.forbidden('You are not allowed to list the blocks of this site.')
      }
      return CARDINAL.models.blocks.getSiteBlocks(req.params.siteId)
    }
  )

  app.post<{ Params: { siteId: string } }>(
    '/sites/:siteId/blocks',
    {
      /*
        The AST validation below constrains only the literal `static definition`; the rest of the
        upload is same-origin JavaScript, imported into the app on every page view that uses the
        block. `manage:sites` is therefore the entire security boundary. Deliberately one tier
        tighter than the PUT and DELETE routes, which also accept `site:blocks`: introducing new
        script is the more sensitive act. See docs/audits/security-reviews/custom-block-upload.md.
      */
      config: {
        permissions: ['manage:sites']
      },
      // -> Tighter than the generic `/_api/*` ceiling: a burst of single-file requests is a caller
      //    working around the batch endpoint's file-count cap.
      preHandler: limitUploads,
      schema: {
        summary: 'Upload a custom block',
        description: `The body is the block component's raw \`component.js\` source, not a multipart form — send the bytes with their \`Content-Type\`. At most ${Math.round((CARDINAL.config.security?.uploadMaxFileSize ?? 10485760) / 1024 / 1024)} MB. The declared \`Content-Type\` decides nothing: the source is parsed for a static \`definition\`, the same way the \`blocks/\` build itself does, and anything that fails to parse or whose definition is not plain literals is rejected with a message naming what was wrong.\n\nThe definition's \`block\` becomes this block's tag — the element it renders as is \`<block-{tag}>\` — and is checked against every other block already on this site, built-in or custom. A collision is rejected rather than silently letting one block shadow another. The source must itself call \`customElements.define("block-{tag}", ...)\` with that exact name; a mismatch is rejected too, since a block that does not register the tag it promises renders nothing on every page that uses it.`,
        tags: ['Blocks'],
        consumes: ['*/*'],
        params: { $ref: 'SiteIdParams#' },
        response: {
          200: {
            description: 'Custom block uploaded successfully',
            type: 'object',
            properties: {
              ok: {
                type: 'boolean'
              },
              message: {
                type: 'string'
              },
              block: { $ref: 'Block#' }
            }
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' }
        }
      }
    },
    async (req, reply) => {
      const data = req.body
      if (!Buffer.isBuffer(data) || data.length < 1) {
        return reply.badRequest('No file was sent.')
      }

      const result = extractBlockDefinition(data.toString('utf8'))
      if (!result.ok) {
        return reply.badRequest(result.error.message)
      }
      const { definition } = result
      if (!definition.block || typeof definition.block !== 'string') {
        return reply.badRequest('component.js has no "block" tag in its static definition.')
      }

      /*
        The definition's "block" promises the element renders as `block-{block}`, which the frontend
        hardcodes. An upload whose define() call names anything else would render nothing on every
        page that uses it, with no error anywhere.
      */
      const expectedTag = `block-${definition.block}`
      const definedTag = extractDefinedElementTag(data.toString('utf8'))
      if (definedTag !== expectedTag) {
        return reply.badRequest(
          definedTag
            ? `component.js calls customElements.define("${definedTag}", ...), but its definition's "block" ("${definition.block}") requires it to register "${expectedTag}".`
            : `component.js must call customElements.define("${expectedTag}", ...) to match its definition's "block" ("${definition.block}").`
        )
      }

      if (await CARDINAL.models.blocks.isTagTaken(req.params.siteId, definition.block)) {
        return reply.conflict(
          `A block already registers the tag "block-${definition.block}" on this site.`
        )
      }

      const block = await CARDINAL.models.blocks.createCustomBlock(
        req.params.siteId,
        definition,
        data
      )

      return {
        ok: true,
        message: 'Custom block uploaded successfully.',
        block
      }
    }
  )

  app.post<{ Params: { siteId: string } }>(
    '/sites/:siteId/blocks/batch',
    {
      /*
        `manage:sites` alone, for the reason given on the single-file upload route above.
      */
      config: {
        permissions: ['manage:sites']
      },
      schema: {
        summary: 'Upload several custom blocks in one request',
        description: `A \`multipart/form-data\` sibling of \`POST .../blocks\` (OpenProject #3211): several \`component.js\` files in one request (field name \`files\`, repeated), each validated exactly as the single-file route validates one — parsed for a static \`definition\`, its declared \`block\` tag checked against every other block already on this site (built-in, custom, OR already claimed earlier in this same batch — two files in one request cannot both win the same tag), and its \`customElements.define(...)\` call checked against that tag. At most ${CARDINAL.config.security?.uploadMaxFilesPerBatch ?? 10} files per request (admin-configurable), enforced by the multipart parser itself at parse time, before a file over that count is ever read into memory — exceeding it answers 413 for the whole request rather than a partial result. Each file is still individually capped at ${Math.round((CARDINAL.config.security?.uploadMaxFileSize ?? 10485760) / 1024 / 1024)} MB, same limit the single-file route enforces. The response carries one result per file, in the order they were sent — a bad file in the batch fails only its own entry, so check each entry's own \`ok\`.`,
        tags: ['Blocks'],
        consumes: ['multipart/form-data'],
        params: { $ref: 'SiteIdParams#' },
        response: {
          200: {
            description: 'One result per uploaded file',
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              message: { type: 'string' },
              results: {
                type: 'array',
                items: { $ref: 'BlockBatchUploadItem#' }
              }
            }
          },
          400: { $ref: 'ApiError#' },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          413: {
            $ref: 'ApiError#',
            description: 'More files than `security.uploadMaxFilesPerBatch` allows in one request.'
          }
        }
      }
    },
    async (req, reply) => {
      const results: { fileName: string; ok: boolean; message?: string; block?: unknown }[] = []
      // -> Creates are awaited in order, so `isTagTaken()` would refuse an in-batch duplicate too;
      //    this set is what lets that refusal name the batch rather than the site.
      const claimedTags = new Set<string>()

      try {
        for await (const part of req.parts()) {
          if (part.type !== 'file') {
            continue
          }
          const data = await part.toBuffer()
          if (part.file.truncated) {
            results.push({
              fileName: part.filename,
              ok: false,
              message: `This file is larger than the ${Math.round((CARDINAL.config.security?.uploadMaxFileSize ?? 10485760) / 1024 / 1024)} MB upload limit.`
            })
            continue
          }
          if (data.length < 1) {
            results.push({ fileName: part.filename, ok: false, message: 'This file is empty.' })
            continue
          }

          const source = data.toString('utf8')
          const result = extractBlockDefinition(source)
          if (!result.ok) {
            results.push({ fileName: part.filename, ok: false, message: result.error.message })
            continue
          }
          const { definition } = result
          if (!definition.block || typeof definition.block !== 'string') {
            results.push({
              fileName: part.filename,
              ok: false,
              message: 'component.js has no "block" tag in its static definition.'
            })
            continue
          }

          const expectedTag = `block-${definition.block}`
          const definedTag = extractDefinedElementTag(source)
          if (definedTag !== expectedTag) {
            results.push({
              fileName: part.filename,
              ok: false,
              message: definedTag
                ? `component.js calls customElements.define("${definedTag}", ...), but its definition's "block" ("${definition.block}") requires it to register "${expectedTag}".`
                : `component.js must call customElements.define("${expectedTag}", ...) to match its definition's "block" ("${definition.block}").`
            })
            continue
          }

          if (claimedTags.has(definition.block)) {
            results.push({
              fileName: part.filename,
              ok: false,
              message: `Another file in this batch already registers the tag "block-${definition.block}".`
            })
            continue
          }
          if (await CARDINAL.models.blocks.isTagTaken(req.params.siteId, definition.block)) {
            results.push({
              fileName: part.filename,
              ok: false,
              message: `A block already registers the tag "block-${definition.block}" on this site.`
            })
            continue
          }

          claimedTags.add(definition.block)
          try {
            const block = await CARDINAL.models.blocks.createCustomBlock(
              req.params.siteId,
              definition,
              data
            )
            results.push({ fileName: part.filename, ok: true, block })
          } catch (err: any) {
            results.push({
              fileName: part.filename,
              ok: false,
              message: err.message || 'This block could not be uploaded.'
            })
          }
        }
      } catch (err: any) {
        // -> Too many files is the one whole-request failure. It surfaces as `FST_FILES_LIMIT`, or
        //    as `ERR_STREAM_PREMATURE_CLOSE` when the limit trips while an earlier file is still
        //    buffering and `@fastify/multipart` destroys that stream.
        if (err.code === 'FST_FILES_LIMIT' || err.code === 'ERR_STREAM_PREMATURE_CLOSE') {
          return reply.code(413).send({
            ok: false,
            statusCode: 413,
            error: 'Payload Too Large',
            message: `This batch has more files than the ${CARDINAL.config.security?.uploadMaxFilesPerBatch ?? 10} file limit for one request.`
          })
        }
        throw err
      }

      if (results.length < 1) {
        return reply.badRequest('No files were sent.')
      }

      return {
        ok: true,
        message: `${results.filter((r) => r.ok).length} of ${results.length} file(s) uploaded successfully.`,
        results
      }
    }
  )

  app.put<{
    Params: { siteId: string }
    Body: { states: { id: string; isEnabled: boolean; config?: Record<string, any> }[] }
  }>(
    '/sites/:siteId/blocks',
    {
      /*
        No route-level `permissions`: who may change a site's blocks comes from `checkSiteAccess()`,
        which that hook cannot call — see `models/groups.ts#checkSiteAdminAccess`.
      */
      schema: {
        summary: 'Enable or disable site blocks',
        description:
          'Only the blocks listed are affected; any others keep their current state. A state may also carry a `config` object of site-level values for that block (e.g. the "Server" field block-kroki and block-plantuml offer) — omitted, its row keeps whatever config it already has; given, for a built-in block it is sanitized against the block\'s declared `config` fields (stale keys stripped) and replaces the row wholesale, while a custom block (no declared fields) is written as-is.\n\nRequires `manage:sites`, or `site:blocks` on this site.',
        tags: ['Blocks'],
        params: { $ref: 'SiteIdParams#' },
        body: {
          type: 'object',
          required: ['states'],
          properties: {
            states: {
              type: 'array',
              items: {
                type: 'object',
                required: ['id', 'isEnabled'],
                properties: {
                  id: {
                    type: 'string',
                    format: 'uuid'
                  },
                  isEnabled: {
                    type: 'boolean'
                  },
                  config: {
                    type: 'object',
                    additionalProperties: true,
                    description:
                      "Site-level config values for this block. For a built-in block, sanitized against its declared `config` fields on write — keys it doesn't declare are stripped; a custom block has no declared fields and is written as-is. Omit to leave the row's existing config untouched."
                  }
                }
              }
            }
          }
        },
        response: {
          200: {
            description: 'Blocks state updated successfully',
            type: 'object',
            properties: {
              ok: {
                type: 'boolean'
              },
              message: {
                type: 'string'
              },
              updated: {
                type: 'integer',
                description:
                  'How many block rows were written. A block already in the requested state still counts.'
              }
            }
          },
          400: {
            $ref: 'ApiError#',
            description: 'A config value failed validation (e.g. block-plantuml\'s "server").'
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' },
          500: { $ref: 'ApiError#', description: 'Failed to write the new block states.' }
        }
      }
    },
    async (req, reply) => {
      if (!maySiteAdmin(req, 'manage:sites', 'site:blocks', req.params.siteId)) {
        return reply.forbidden()
      }

      try {
        const updated = await CARDINAL.models.blocks.setBlocksState(
          req.params.siteId,
          req.body.states
        )
        return {
          ok: true,
          message: 'Blocks state updated successfully.',
          updated
        }
      } catch (err: any) {
        // -> A `CustomError` is a config validation failure carrying its own status and message;
        //    anything else is an actual fault
        if (err instanceof CustomError) {
          throw err
        }
        CARDINAL.logger.error('blocks', 'updating the blocks state failed', {
          error: err,
          reqId: req.id
        })
        return reply.internalServerError()
      }
    }
  )

  app.delete<{ Params: { siteId: string; blockId: string } }>(
    '/sites/:siteId/blocks/:blockId',
    {
      /*
        No route-level `permissions`: same reasoning as the PUT above — see `checkSiteAdminAccess`.
      */
      schema: {
        summary: 'Delete a custom block',
        description:
          'Only custom blocks can be deleted. Built-in blocks are registered from disk and would reappear on the next sync.\n\nRequires `manage:sites`, or `site:blocks` on this site.',
        tags: ['Blocks'],
        params: {
          type: 'object',
          properties: {
            siteId: {
              type: 'string',
              format: 'uuid'
            },
            blockId: {
              type: 'string',
              format: 'uuid'
            }
          },
          required: ['siteId', 'blockId']
        },
        response: {
          204: {
            description: 'Block deleted successfully'
          },
          401: { $ref: 'ApiError#' },
          403: { $ref: 'ApiError#' },
          404: { $ref: 'ApiError#' },
          409: { $ref: 'ApiError#', description: 'The block is built-in and cannot be deleted.' }
        }
      }
    },
    async (req, reply) => {
      if (!maySiteAdmin(req, 'manage:sites', 'site:blocks', req.params.siteId)) {
        return reply.forbidden()
      }

      const siteBlocks = await CARDINAL.models.blocks.getSiteBlocks(req.params.siteId)
      const block = siteBlocks.find((b) => b.id === req.params.blockId)
      if (!block) {
        return reply.notFound('Block does not exist.')
      }
      if (!block.isCustom) {
        return reply.conflict('Cannot delete a built-in block.')
      }

      await CARDINAL.models.blocks.deleteCustomBlock(req.params.siteId, req.params.blockId)
      return reply.code(204).send()
    }
  )
}

export default routes
