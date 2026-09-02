import { approvalMatchModes } from '../../models/approvalRules.ts'
import type { FastifyInstance } from 'fastify'

export async function registerSchemas(app: FastifyInstance): Promise<void> {
  /**
   * APPROVAL RULE - Which pages accept edit suggestions, from whom, and who reviews them
   */
  app.addSchema({
    $id: 'ApprovalRule',
    type: 'object',
    properties: {
      id: {
        type: 'string',
        format: 'uuid'
      },
      name: {
        type: 'string',
        description: 'What the rule is called in the admin list.'
      },
      isEnabled: {
        type: 'boolean',
        description: 'A disabled rule keeps its configuration but covers nothing.'
      },
      match: {
        type: 'string',
        enum: [...approvalMatchModes],
        description:
          'How `path` is compared: the same modes group page rules use. `TAG` matches a page carrying any of the listed tags, `TAGALL` one carrying all of them.'
      },
      path: {
        type: 'string',
        description:
          'The pattern, without a leading slash. A comma-separated list of tags for the tag modes.'
      },
      submitterGroups: {
        type: 'array',
        description: 'IDs of the groups whose members may submit edit suggestions.',
        items: {
          type: 'string',
          format: 'uuid'
        }
      },
      reviewerGroups: {
        type: 'array',
        description:
          'IDs of the groups that review those submissions, and are notified when one comes in.',
        items: {
          type: 'string',
          format: 'uuid'
        }
      },
      minApprovals: {
        type: 'integer',
        minimum: 1,
        description:
          'How many distinct reviewers must approve a submission this rule covers before it is written to the page. 1 is an ordinary single-approver sign-off.'
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
   * PAGE EDIT SUBMISSION - An edit somebody suggested, as its reviewer sees it
   */
  app.addSchema({
    $id: 'PageEditSubmission',
    type: 'object',
    properties: {
      id: {
        type: 'string',
        format: 'uuid'
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
      },
      isStale: {
        type: 'boolean',
        description:
          'The page has changed since this was written against it, so accepting it wholesale would undo whatever changed in between.'
      },
      page: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          path: { type: 'string' },
          title: { type: 'string' },
          locale: { type: 'string' }
        }
      },
      author: {
        type: 'object',
        properties: {
          id: {
            type: ['string', 'null'],
            description: 'Null for a guest, who has no account.'
          },
          name: { type: 'string' },
          email: { type: 'string' },
          isGuest: { type: 'boolean' }
        }
      },
      approvals: {
        type: 'object',
        description: 'Where this submission stands against its covering rule’s approval threshold.',
        properties: {
          approvalsCount: {
            type: 'integer',
            description: 'How many distinct reviewers have approved it so far.'
          },
          approvalsRequired: {
            type: 'integer',
            description:
              'How many are required before it is written to the page -- the strictest of every enabled rule covering it.'
          },
          hasApproved: {
            type: 'boolean',
            description: 'Whether the caller already cast their own approval towards that count.'
          }
        }
      }
    }
  })

  /**
   * PAGE EDIT SUBMISSION DETAIL - The same, with both sides of the diff
   */
  app.addSchema({
    $id: 'PageEditSubmissionDetail',
    allOf: [
      { $ref: 'PageEditSubmission#' },
      {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: 'What the suggestion proposes the page should say.'
          },
          pageContent: {
            type: 'string',
            description: 'What it currently says.'
          },
          patch: {
            type: 'string',
            description: 'Unified diff against the page as it stood when the suggestion was made.'
          }
        }
      }
    ]
  })

  /**
   * APPROVAL RULE INPUT - The fields a rule is written with
   */
  app.addSchema({
    $id: 'ApprovalRuleInput',
    type: 'object',
    properties: {
      name: {
        type: 'string',
        minLength: 1,
        maxLength: 255
      },
      isEnabled: {
        type: 'boolean'
      },
      match: {
        type: 'string',
        enum: [...approvalMatchModes]
      },
      path: {
        type: 'string',
        maxLength: 2048
      },
      submitterGroups: {
        type: 'array',
        items: {
          type: 'string',
          format: 'uuid'
        }
      },
      reviewerGroups: {
        type: 'array',
        items: {
          type: 'string',
          format: 'uuid'
        }
      },
      minApprovals: {
        type: 'integer',
        minimum: 1
      }
    }
  })
}
