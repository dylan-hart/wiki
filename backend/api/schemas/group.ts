import { GROUP_RULE_MATCH_VALUES } from '../../models/groups.ts'
import type { FastifyInstance } from 'fastify'
import { GLOBAL_PERMISSIONS, PAGE_PERMISSIONS } from '../../helpers/permissions.ts'
import { SITE_PERMISSIONS } from '../../helpers/siteRules.ts'

export async function registerSchemas(app: FastifyInstance): Promise<void> {
  /**
   * Separate from `ApiKeyScopePermission#`, which also allows page permissions: a group's
   * `permissions` is global-only, page access is granted through `rules`.
   */
  app.addSchema({
    $id: 'GlobalPermission',
    type: 'string',
    enum: GLOBAL_PERMISSIONS
  })

  /**
   * A variable rather than an inline literal so `if`/`then` can be attached by assignment below --
   * oxlint's `unicorn/no-thenable` flags a literal `then` key.
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
          type: 'string',
          enum: [...PAGE_PERMISSIONS, ...SITE_PERMISSIONS]
        }
      },
      match: {
        type: 'string',
        description:
          "How `path` is compared against the page path. CLASSIFICATION is the odd one out: it ignores `path` entirely and matches a page's `classification` against `classifications` instead — see GROUP_RULE_MATCH_VALUES in models/groups.ts, which this enum is generated from.",
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
      tags: {
        type: 'array',
        description:
          'Tags this rule addresses. Read only when `match` is TAG or TAGALL, the same way `classifications` is read only for CLASSIFICATION -- a first-class array rather than the comma list `path` used to carry for these two match kinds.',
        items: {
          type: 'string',
          maxLength: 255
        }
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
          'Classification level IDs this rule addresses. Read only when `match` is CLASSIFICATION, the same way `tags` is read only for TAG/TAGALL.',
        items: {
          type: 'string',
          format: 'uuid'
        }
      }
    }
  }
  // -> START/SUBTREE/END/EXACT compare `path` against a page path, which is always stored lowercased
  //    (`normalizePagePath`), so a mixed-case rule could never match -- silently, for a DENY rule.
  //    REGEX may deliberately use a class like `[A-Z]`; the other match kinds do not read `path`.
  groupRuleSchema['if'] = {
    properties: {
      match: { enum: ['START', 'SUBTREE', 'END', 'EXACT'] }
    },
    required: ['match']
  }
  // -> Plain JSON Schema, not a thenable -- this object is only ever handed to `app.addSchema()`,
  // never awaited.
  // oxlint-disable-next-line unicorn/no-thenable
  groupRuleSchema['then'] = {
    properties: {
      path: {
        type: 'string',
        pattern: '^[^A-Z]*$'
      }
    }
  }
  app.addSchema(groupRuleSchema)

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
