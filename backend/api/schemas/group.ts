import type { FastifyInstance } from 'fastify'
import { GROUP_RULE_MATCH_VALUES } from '../../models/groups.ts'

export async function registerSchemas(app: FastifyInstance): Promise<void> {
  /**
   * GROUP RULE - A single page rule within a group
   *
   * Built as a variable, rather than inline in the `addSchema()` call below, purely so the
   * `if`/`then` JSON-Schema keywords (added via bracket assignment further down) can be attached
   * without an object literal spelling out a `then` property -- oxlint's `unicorn/no-thenable` flags
   * that shape on sight, even though this is plain JSON Schema and no `await` ever sees the object.
   */
  const groupRuleSchema: Record<string, unknown> = {
    $id: 'GroupRule',
    type: 'object',
    required: ['id', 'name', 'roles', 'match', 'mode', 'path'],
    properties: {
      id: {
        type: 'string',
        description: 'Client-generated identifier, unique within the group.'
      },
      name: {
        type: 'string',
        minLength: 1,
        maxLength: 255
      },
      roles: {
        type: 'array',
        description: 'Permissions granted or denied by this rule.',
        items: {
          type: 'string'
        }
      },
      match: {
        type: 'string',
        description: 'How `path` is compared against the page path.',
        enum: GROUP_RULE_MATCH_VALUES
      },
      mode: {
        type: 'string',
        description:
          'ALLOW grants the roles, DENY revokes them, FORCEALLOW grants them and cannot be overridden by a later DENY.',
        enum: ['ALLOW', 'DENY', 'FORCEALLOW']
      },
      path: {
        type: 'string',
        maxLength: 255
      },
      locales: {
        type: 'array',
        description: 'Locale codes this rule is limited to. Empty means all locales.',
        items: {
          type: 'string'
        }
      },
      sites: {
        type: 'array',
        description: 'Site IDs this rule is limited to. Empty means all sites.',
        items: {
          type: 'string',
          format: 'uuid'
        }
      },
      classifications: {
        type: 'array',
        description:
          'Classification level IDs this rule addresses. Only read when `match` is `CLASSIFICATION`.',
        items: {
          type: 'string',
          format: 'uuid'
        }
      }
    }
  }
  // -> START/END/EXACT compare `path` directly against a page path, which is always stored
  //    lowercased (`normalizePagePath`) -- so a mixed-case rule could never match, and for a DENY
  //    rule that failure is silent (OpenProject #2182). Rejected here at write time, on top of the
  //    lowercasing fold in `models/groups.ts#updateGroup` and the case-insensitive comparison in
  //    `helpers/pageRules.ts#ruleMatchesPage`. TAG/TAGALL read `path` as a comma list, REGEX as a
  //    pattern that may deliberately use a character class like `[A-Z]`, and CLASSIFICATION does
  //    not read `path` at all -- none of those are constrained.
  groupRuleSchema['if'] = {
    properties: {
      match: { enum: ['START', 'END', 'EXACT'] }
    },
    required: ['match']
  }
  // -> Plain JSON Schema, not a thenable -- this object is only ever handed to `app.addSchema()`,
  // never awaited.
  // oxlint-disable-next-line unicorn/no-thenable
  groupRuleSchema['then'] = {
    properties: {
      path: {
        pattern: '^[^A-Z]*$'
      }
    }
  }
  app.addSchema(groupRuleSchema)

  /**
   * GROUP CORE - Essential fields only
   */
  app.addSchema({
    $id: 'GroupCore',
    type: 'object',
    properties: {
      id: {
        type: 'string',
        format: 'uuid'
      },
      name: {
        type: 'string',
        minLength: 1,
        maxLength: 255
      },
      isSystem: {
        type: 'boolean',
        description: 'System groups cannot be deleted.'
      },
      userCount: {
        type: 'number',
        description: 'Number of users assigned to this group.'
      },
      createdAt: {
        type: 'string',
        format: 'date-time',
        description: 'RFC 3339 Date Time'
      },
      updatedAt: {
        type: 'string',
        format: 'date-time',
        description: 'RFC 3339 Date Time'
      }
    }
  })

  /**
   * GROUP - All fields
   */
  app.addSchema({
    $id: 'Group',
    allOf: [
      {
        $ref: 'GroupCore#'
      },
      {
        type: 'object',
        properties: {
          permissions: {
            type: 'array',
            description: 'Global permissions granted to members of this group.',
            items: {
              type: 'string'
            }
          },
          rules: {
            type: 'array',
            items: {
              $ref: 'GroupRule#'
            }
          },
          redirectOnLogin: {
            type: 'string'
          },
          redirectOnFirstLogin: {
            type: 'string'
          },
          redirectOnLogout: {
            type: 'string'
          }
        }
      }
    ]
  })
}
