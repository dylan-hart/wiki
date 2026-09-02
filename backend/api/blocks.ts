import { extractBlockDefinition, extractDefinedElementTag } from '../helpers/blockDefinition.ts'
import { CustomError } from '../helpers/common.ts'
import { maySiteAdmin } from '../helpers/siteRules.ts'
import type { FastifyInstance, FastifyRequest } from 'fastify'

/**
 * Group-wide permissions that carry the block list on their own.
 *
 * Only the ones a group really is granted as a blanket. Writing a page is NOT among them, however much
 * it sounds like it belongs: page permissions come from a group's rules, and are read below.
 */
const LIST_PERMISSIONS = ['manage:sites', 'manage:system']

/** The page rules that make somebody an author, i.e. able to put a block into a page directly. */
const AUTHOR_ROLES = ['write:pages', 'manage:pages']

/**
 * Whether this caller has any business seeing which blocks a site has.
 *
 * The list is what the editor's block picker is built from, so it belongs to whoever may put a block
 * into a page. Three ways of being that person:
 *
 *   - an administrator, from the group-wide list above;
 *   - an author, from a page rule that lets them write somewhere on this site;
 *   - anyone an enabled approval rule lets SUGGEST an edit — the guests group included, when a wiki
 *     has opened suggestions to the public. A suggestion is written in the same editor, with the same
 *     picker in it, and refusing the list there leaves the button throwing an error at a reader who
 *     was invited to use it.
 *
 * Asked of the site rather than of a page, because that is what the answer is about: which blocks
 * exist here. Nothing in the reply is page-specific, so a rule anywhere on the site settles it — what
 * may be written WHERE is decided by the page and suggestion routes, as it is for everything else.
 *
 * The route-level permission hook cannot answer any of this: it reads the group-wide list alone, and
 * both writing a page and suggesting an edit are granted by rules instead.
 */
async function mayListBlocks(req: FastifyRequest, siteId: string): Promise<boolean> {
  const actor = WIKI.models.groups.actorForRequest(req)
  if (LIST_PERMISSIONS.some((permission) => actor.permissions.includes(permission))) {
    return true
  }
  // -> Both of these read cached group rules; only the last resort goes to the database
  if (
    WIKI.models.groups
      .rulesForGroups(actor.groupIds)
      .some(
        (rule) => rule.mode !== 'DENY' && AUTHOR_ROLES.some((role) => rule.roles?.includes(role))
      )
  ) {
    return true
  }
  const groupIds = WIKI.models.approvals.getActorGroupIds(req)
  const rules = await WIKI.models.approvalRules.getRules(siteId)
  return rules.some(
    (rule) => rule.isEnabled && rule.submitterGroups.some((id) => groupIds.includes(id))
  )
}

/**
 * Blocks API Routes
 */
async function routes(app: FastifyInstance) {
  // -> An upload is the raw `component.js` source rather than a multipart form: one file per
  //    request, exactly like `assets.ts`'s own upload route. The catch-all only claims content types
  //    nothing else in this plugin parses, so the JSON routes below are unaffected — and it is scoped
  //    to this plugin instance, not global, the same way `assets.ts`'s and `sites.ts`'s each are.
  app.addContentTypeParser(
    '*',
    { parseAs: 'buffer', bodyLimit: WIKI.config.security?.uploadMaxFileSize ?? 10485760 },
    (req, body, done) => {
      done(null, body)
    }
  )

  /**
   * LIST SITE BLOCKS
   */
  app.get<{ Params: { siteId: string } }>(
    '/sites/:siteId/blocks',
    {
      /*
        No route-level `permissions`: who may see this list comes down to a group's rules, which that
        hook does not read — and it would refuse an anonymous reader outright, when a wiki that takes
        public suggestions has invited exactly that reader to use the picker. See `mayListBlocks`.
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
      return WIKI.models.blocks.getSiteBlocks(req.params.siteId)
    }
  )

  /**
   * UPLOAD CUSTOM BLOCK
   */
  app.post<{ Params: { siteId: string } }>(
    '/sites/:siteId/blocks',
    {
      /*
        Security posture (full review: docs/security/custom-block-upload.md): the AST validator below
        only constrains the literal `static definition` metadata block — it cannot and does not
        sandbox the rest of the uploaded source. Everything else in the file is full same-origin
        JavaScript, imported straight into the app's module graph on every page view that uses the
        block (`loadBlocks()` — no iframe, Worker or shadow-DOM script boundary). `manage:sites` is
        therefore the entire security boundary for this route, not a formality alongside some other
        containment layer — a knowing, not incidental, trust decision: anyone holding `manage:sites`
        on a site can already inject markup into every page of it, and this route extends that to
        arbitrary script, wiki-wide, on the next page view of any block using it. `manage:sites` is
        also the only correct gate available here: it is a closed, group-wide permission (CLAUDE.md's
        Permissions section) and no new, narrower permission name may be invented for this route.

        NOT applied identically on the PUT (enable/disable) and DELETE routes below: those also accept
        the narrower site-scoped `site:blocks` delegation (`checkSiteAdminAccess()`, backed by
        `checkSiteAccess()` — see `docs/decisions/delegated-per-site-administration.md` §3, which lists
        `site:blocks` as covering exactly these two routes). That is a deliberate, accepted widening,
        not an inconsistency: introducing NEW arbitrary script is the more sensitive act, so upload
        stays gated on `manage:sites` alone one tier tighter than merely enabling, disabling or deleting
        a block someone with `manage:sites` already put there. Full reconciliation:
        docs/security/custom-block-upload.md (OpenProject #2128).
      */
      config: {
        permissions: ['manage:sites']
      },
      schema: {
        summary: 'Upload a custom block',
        description: `The body is the block component's raw \`component.js\` source, not a multipart form — send the bytes with their \`Content-Type\`. At most ${Math.round((WIKI.config.security?.uploadMaxFileSize ?? 10485760) / 1024 / 1024)} MB. The declared \`Content-Type\` decides nothing: the source is parsed for a static \`definition\`, the same way the \`blocks/\` build itself does, and anything that fails to parse or whose definition is not plain literals is rejected with a message naming what was wrong.\n\nThe definition's \`block\` becomes this block's tag — the element it renders as is \`<block-{tag}>\` — and is checked against every other block already on this site, built-in or custom. A collision is rejected rather than silently letting one block shadow another. The source must itself call \`customElements.define("block-{tag}", ...)\` with that exact name; a mismatch is rejected too, since a block that does not register the tag it promises renders nothing on every page that uses it.`,
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
        The definition's "block" promises the element renders as `block-{block}` (documented above,
        and what the frontend's block loader and blockMarkdown()/findBlocks() hardcode) — but nothing
        upstream of this actually confirms the uploaded code registers that tag. An upload whose
        define() call names anything else is accepted silently otherwise, and then renders nothing on
        every page it's used on, with no error anywhere.
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

      if (await WIKI.models.blocks.isTagTaken(req.params.siteId, definition.block)) {
        return reply.conflict(
          `A block already registers the tag "block-${definition.block}" on this site.`
        )
      }

      const block = await WIKI.models.blocks.createCustomBlock(req.params.siteId, definition, data)

      return {
        ok: true,
        message: 'Custom block uploaded successfully.',
        block
      }
    }
  )

  /**
   * SET SITE BLOCKS STATE
   */
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
        const updated = await WIKI.models.blocks.setBlocksState(req.params.siteId, req.body.states)
        return {
          ok: true,
          message: 'Blocks state updated successfully.',
          updated
        }
      } catch (err: any) {
        // -> A validation failure (e.g. an invalid block-plantuml "server") carries its own status
        //    code and a message worth showing the admin who typed it; anything else is an actual fault
        if (err instanceof CustomError) {
          throw err
        }
        WIKI.logger.warn(err)
        return reply.internalServerError()
      }
    }
  )

  /**
   * DELETE CUSTOM BLOCK
   */
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

      const siteBlocks = await WIKI.models.blocks.getSiteBlocks(req.params.siteId)
      const block = siteBlocks.find((b) => b.id === req.params.blockId)
      if (!block) {
        return reply.notFound('Block does not exist.')
      }
      if (!block.isCustom) {
        return reply.conflict('Cannot delete a built-in block.')
      }

      await WIKI.models.blocks.deleteCustomBlock(req.params.siteId, req.params.blockId)
      return reply.code(204).send()
    }
  )
}

export default routes
