import { pageHistoryActions, pageHistoryVia } from '../../models/pageHistory.ts'
import type { FastifyInstance } from 'fastify'

/**
 * A date that may not be set.
 *
 * An empty string counts as unset alongside null, because that is how the editor holds a date nobody
 * has filled in — rejecting it would fail every save of a page that is not scheduled.
 */
const optionalDateTime = {
  anyOf: [
    { type: 'string', format: 'date-time' },
    { type: 'string', maxLength: 0 },
    { type: 'null' }
  ],
  description: 'Empty or null when there is no date.'
}

export async function registerSchemas(app: FastifyInstance): Promise<void> {
  /**
   * PAGE RELATION - One "related page" button, as `PageRelationDialog.vue` writes it and `Index.vue`
   * renders it. The only producer is that dialog (see `create()`/`persist()`), so unlike the other
   * `additionalProperties: true` blobs in this file, this shape is fixed and worth stating exactly.
   */
  app.addSchema({
    $id: 'PageRelation',
    type: 'object',
    required: ['id', 'position', 'label', 'icon', 'target'],
    properties: {
      id: {
        type: 'string',
        description: 'Client-generated, so this relation can be found again to edit or remove it.'
      },
      position: {
        type: 'string',
        enum: ['left', 'center', 'right']
      },
      label: {
        type: 'string'
      },
      caption: {
        type: 'string',
        description: 'Only ever set for a `left` or `right` relation; a `center` one has none.'
      },
      icon: {
        type: 'string',
        description: 'An Iconify reference, e.g. `tabler:arrow-left`.'
      },
      target: {
        type: 'string',
        description: 'A rooted path within this wiki, or a complete URL.'
      }
    }
  })

  /**
   * PAGE TOC NODE - One heading in the table of contents, as `rendering.ts`'s `anchorHeadings` /
   * `nestHeadings` build it.
   */
  app.addSchema({
    $id: 'PageTocNode',
    type: 'object',
    required: ['key', 'label', 'level', 'children'],
    properties: {
      key: {
        type: 'string'
      },
      label: {
        type: 'string'
      },
      level: {
        type: 'integer',
        minimum: 1,
        maximum: 6
      },
      children: {
        type: 'array',
        items: { $ref: 'PageTocNode#' }
      }
    }
  })

  /**
   * PAGE INPUT - The writable fields, used for both create and update
   */
  app.addSchema({
    $id: 'PageInput',
    type: 'object',
    properties: {
      path: {
        type: 'string',
        maxLength: 255,
        pattern: '^/?[a-zA-Z0-9-_/]*$',
        description: 'Where the page lives, without a leading slash. Lowercased when stored.'
      },
      title: {
        type: 'string',
        minLength: 1,
        maxLength: 255
      },
      description: {
        type: 'string',
        maxLength: 255
      },
      icon: {
        type: 'string',
        maxLength: 255
      },
      alias: {
        type: 'string',
        maxLength: 255,
        pattern: '^[a-zA-Z0-9-_]*$'
      },
      locale: {
        type: 'string',
        minLength: 1,
        maxLength: 10,
        description: "The site's primary locale when absent."
      },
      editor: {
        type: 'string',
        maxLength: 255,
        description:
          'Which editor authored the content, e.g. `markdown`. `redirect` is a page with no body at all: it sends its reader elsewhere, is never searchable, and its content is the JSON below rather than a document.'
      },
      content: {
        type: 'string',
        description:
          'The source, in whatever the editor writes. For a `redirect` page, `{ "kind": "page" | "url", "target": string, "showInterstitial": boolean }` — a page target is a rooted path within this wiki, a URL target a complete http(s) address.'
      },
      render: {
        type: 'string',
        description:
          "The HTML the editor produced. Sanitized against the author's permissions before it is stored, and the table of contents and search text are derived from the result — so what comes back may differ from what was sent."
      },
      publishState: {
        type: 'string',
        enum: ['draft', 'published', 'scheduled']
      },
      publishStartDate: optionalDateTime,
      publishEndDate: optionalDateTime,
      isBrowsable: {
        type: 'boolean'
      },
      isSearchable: {
        type: 'boolean'
      },
      password: {
        type: 'string',
        maxLength: 255,
        description:
          "A new password to protect the page with, in plaintext — the server hashes it before storing it and never returns it again (see `Page.hasPassword`). Omit to leave the page's password untouched; an empty string removes it."
      },
      relations: {
        type: 'array',
        items: { $ref: 'PageRelation#' }
      },
      tags: {
        type: 'array',
        items: {
          type: 'string'
        }
      },
      classification: {
        type: 'string',
        format: 'uuid',
        description:
          "The classification level id (OpenProject #1079) to give the page. On create, defaults to the immediate parent page's own level, or the most-open configured level when there is no parent page. On update, lowering it (declassifying) requires `manage:classification` on top of `write:pages`/`manage:pages`; either direction is refused with 400 if it would put the page below its immediate parent's floor (#1080)."
      },
      allowComments: { type: 'boolean' },
      allowContributions: { type: 'boolean' },
      showSidebar: { type: 'boolean' },
      showTags: { type: 'boolean' },
      showToc: { type: 'boolean' },
      tocDepth: {
        type: 'object',
        properties: {
          min: { type: 'integer', minimum: 1, maximum: 6 },
          max: { type: 'integer', minimum: 1, maximum: 6 }
        }
      },
      reasonForChange: {
        type: 'string',
        maxLength: 255,
        description:
          "Why this save is being made, as the editor's reason-for-change prompt collected it. Not stored on the page: it is recorded on the history version this save produces."
      },
      expectedUpdatedAt: {
        type: 'string',
        format: 'date-time',
        description:
          "The page's `updatedAt` as the editor last saw it, for optimistic concurrency on update. When present and it no longer matches the stored value — somebody else saved in between — the write is refused with 409 instead of overwriting their change. Ignored on create, and ignored by an in-progress collab session, whose own saves keep this field current."
      }
    }
  })

  /**
   * PAGE - A page as it is served back
   */
  app.addSchema({
    $id: 'Page',
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      path: { type: 'string' },
      hash: {
        type: 'string',
        description: 'Hash of the path, which is how a page is addressed by URL.'
      },
      alias: { type: ['string', 'null'] },
      title: { type: 'string' },
      description: { type: ['string', 'null'] },
      icon: { type: ['string', 'null'] },
      locale: { type: 'string' },
      editor: { type: 'string' },
      contentType: { type: 'string' },
      publishState: { type: 'string', enum: ['draft', 'published', 'scheduled'] },
      publishStartDate: { type: ['string', 'null'], format: 'date-time' },
      publishEndDate: { type: ['string', 'null'], format: 'date-time' },
      isBrowsable: { type: 'boolean' },
      isSearchable: { type: 'boolean' },
      hasPassword: {
        type: 'boolean',
        description:
          'Whether the page has a password set. Only present for a requester who may edit the page — the password itself is never returned by this or any other route; set a new one with `password` on `PATCH`/`POST`.'
      },
      isLocked: {
        type: 'boolean',
        description:
          'The page is password protected and this requester has not entered it, so `content`, `render` and `toc` were withheld. Unlock it with `POST …/unlock`.'
      },
      relations: {
        type: 'array',
        items: { $ref: 'PageRelation#' }
      },
      tags: { type: 'array', items: { type: 'string' } },
      classification: {
        type: 'string',
        format: 'uuid',
        description: 'The classification level id this page carries (OpenProject #1079).'
      },
      toc: {
        type: 'array',
        description:
          'Nested headings, derived from the stored render. Each carries its own `level` — the heading tag it came from — as well as its place in the tree, since which headings a contents list shows is a question about the tag rather than about the nesting.',
        items: { $ref: 'PageTocNode#' }
      },
      render: { type: 'string' },
      content: {
        type: 'string',
        description:
          'Only present when the request asked for it — except on a redirection, whose content is where it sends its reader rather than a body, and comes back either way.'
      },
      allowComments: { type: 'boolean' },
      commentsCount: {
        type: 'integer',
        description: 'How many comments this page has, replies included.'
      },
      allowContributions: { type: 'boolean' },
      showSidebar: { type: 'boolean' },
      showTags: { type: 'boolean' },
      showToc: { type: 'boolean' },
      tocDepth: {
        type: 'object',
        properties: {
          min: { type: 'integer' },
          max: { type: 'integer' }
        }
      },
      navigationId: { type: ['string', 'null'] },
      navigationMode: { type: 'string' },
      authorId: { type: 'string', format: 'uuid' },
      authorName: { type: 'string' },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
      viewer: {
        type: 'object',
        description:
          'Where the requester stands on this page: what they may do to it, whether they may suggest an edit, and whether they review it. Present when a page is fetched on its own — the page view draws its controls from this, rather than asking three further endpoints about a page it already has. Absent from a page returned by a save.',
        properties: {
          permissions: {
            type: 'array',
            items: { type: 'string' },
            description:
              'The page permissions held AT THIS PATH, as this reader’s groups’ rules decide. The same answer `pages/userPermissions` gives for the path.'
          },
          canSuggestEdits: {
            type: 'boolean',
            description:
              'An enabled approval rule covers this page and names a group the requester is in, and the page allows contributions.'
          },
          hasOpenSuggestion: {
            type: 'boolean',
            description:
              'The requester already has a suggestion waiting on this page, which they would carry on with rather than start again. Always false for a guest, whose suggestions are attributed to nobody.'
          },
          canReview: {
            type: 'boolean',
            description: 'The requester reviews this page. Always false without an account.'
          },
          isWatching: {
            type: 'boolean',
            description:
              'The requester has asked to be told about changes to this page. Always false without an account, since a watch belongs to one.'
          },
          pendingSubmissions: {
            type: 'array',
            items: { $ref: 'PageEditSubmission#' },
            description: 'What is waiting on this page, oldest first. Empty unless `canReview`.'
          },
          resolvedSubmission: {
            type: ['object', 'null'],
            description:
              'What became of the requester’s most recently resolved suggestion on this page, if they made one and a reviewer has acted on it. Null while nothing of theirs has been resolved, or for a guest, whose suggestions are attributed to nobody.',
            properties: {
              status: { type: 'string', enum: ['approved', 'declined'] },
              reason: {
                type: ['string', 'null'],
                description: 'The reviewer’s note on why. Always null for an approval.'
              },
              resolvedAt: { type: 'string', format: 'date-time' }
            }
          },
          activeEditors: {
            type: 'object',
            description:
              'Who else has this page open in a live collaboration room on this instance, right now — a same-instance approximation, not a cluster-wide count (see `core/collab.ts#participantInfo`). Always zero on a site with collaborative editing off.',
            properties: {
              count: { type: 'integer' },
              names: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'Best-effort: only those participants whose awareness state carries a name.'
              }
            }
          },
          draft: {
            type: ['object', 'null'],
            description:
              'An unsaved draft recorded when this page\'s collaboration room last closed with edits still pending (OpenProject #2455) -- what the editor offers to restore as "you have unsaved changes from a previous session". Null when there is none, when collaborative editing is off for this site, or for a requester who may not write this page (`write:pages`) -- the same requirement joining the room itself has. Content is not included here; fetch it from `GET …/pages/:pageId/draft` once the reader has actually chosen to restore it.',
            properties: {
              updatedAt: { type: 'string', format: 'date-time' },
              authorName: {
                type: ['string', 'null'],
                description: 'Best-effort: who was last known to be editing. Null when unknown.'
              }
            }
          }
        }
      }
    }
  })

  /**
   * WATCH PREFERENCE - The resolved delivery preference on one watch, every field settled
   */
  app.addSchema({
    $id: 'WatchPreference',
    type: 'object',
    properties: {
      notifyMode: {
        type: 'string',
        enum: ['immediate', 'digest'],
        description:
          '`immediate` sends a mail as soon as a change is recorded; `digest` batches changes for a later, periodic send. Defaults to `digest` for a watch nobody has set this on: an instance can start collecting watches before outbound mail (see AdminMail) is even configured, and `digest` fails safe there — it queues instead of attempting a send against a transporter that may not exist. Once mail is confirmed working, a watcher (or an admin, later) can opt into `immediate`.'
      },
      notifyOnEdited: {
        type: 'boolean',
        description: 'Notify when the page is edited. Defaults to true.'
      },
      notifyOnMoved: {
        type: 'boolean',
        description: 'Notify when the page is renamed or moved. Defaults to true.'
      },
      notifyOnDeleted: {
        type: 'boolean',
        description: 'Notify when the page is deleted. Defaults to true.'
      }
    }
  })

  /**
   * WATCH PREFERENCE INPUT - The same fields, all optional: only what is sent is changed
   *
   * `type` includes `null` alongside `object` because `PUT .../watch`'s body is itself optional
   * (re-watching needs no preference at all) — Fastify still runs body validation against whatever
   * `req.body` resolves to when a request carries no payload, which is `null`, not `undefined`.
   */
  app.addSchema({
    $id: 'WatchPreferenceInput',
    type: ['object', 'null'],
    description:
      'A field left out of the body is left exactly as stored — this is a partial update, not a replace, so adjusting one preference never requires first reading the other three back.',
    properties: {
      notifyMode: { type: 'string', enum: ['immediate', 'digest'] },
      notifyOnEdited: { type: 'boolean' },
      notifyOnMoved: { type: 'boolean' },
      notifyOnDeleted: { type: 'boolean' }
    },
    additionalProperties: false
  })

  /**
   * WATCHED PAGE - A page somebody asked to be told about, as their inbox lists it
   */
  app.addSchema({
    $id: 'WatchedPage',
    type: 'object',
    properties: {
      pageId: { type: 'string', format: 'uuid' },
      path: { type: 'string' },
      locale: { type: 'string' },
      title: { type: 'string' },
      description: { type: ['string', 'null'] },
      icon: { type: ['string', 'null'] },
      updatedAt: {
        type: 'string',
        format: 'date-time',
        description: 'When the page last changed, which is what watching it is about.'
      },
      watchedAt: {
        type: 'string',
        format: 'date-time',
        description: 'When the caller started watching it.'
      },
      preference: { $ref: 'WatchPreference#' }
    }
  })

  /**
   * INCLUDED PAGE - Another page's render, as an include block draws it inside the page being read
   */
  app.addSchema({
    $id: 'IncludedPage',
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Slash-separated path of the page that was included.'
      },
      locale: {
        type: 'string'
      },
      title: {
        type: 'string'
      },
      isLocked: {
        type: 'boolean',
        description:
          'The page is password protected and this reader has not entered it, so `render` is empty. An include does not offer the unlock prompt: the reader unlocks the page by opening it.'
      },
      render: {
        type: 'string',
        description: 'The stored HTML, already sanitised when the page was saved.'
      }
    }
  })

  /**
   * PAGE BACKLINK - Another page whose content links to this one (OpenProject #1914)
   */
  app.addSchema({
    $id: 'PageBacklink',
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      path: { type: 'string' },
      locale: { type: 'string' },
      title: { type: 'string' },
      icon: { type: ['string', 'null'] }
    }
  })

  /**
   * PAGE HISTORY ENTRY - One version of a page, as the history timeline lists it
   */
  app.addSchema({
    $id: 'PageHistoryEntry',
    type: 'object',
    properties: {
      id: {
        type: 'string',
        format: 'uuid'
      },
      action: {
        type: 'string',
        enum: [...pageHistoryActions],
        description: 'What happened to the page. `moved` is a change of path or title.'
      },
      via: {
        type: 'string',
        enum: [...pageHistoryVia],
        description:
          "What actually made the change: `editor` for the standard editor (every REST-API-driven save), or `mcp` for an MCP tool call acting on the author's behalf."
      },
      changedFields: {
        type: 'array',
        description:
          'Which page fields the change touched, named as the page stores them. Empty for a creation or a deletion, where the whole page is the change.',
        items: {
          type: 'string'
        }
      },
      reason: {
        type: 'string',
        description:
          "Why the change was made, in the author's words. Empty when the site does not ask for a reason — see the `reasonForChange` site feature — or asked and was not answered."
      },
      versionDate: {
        type: 'string',
        format: 'date-time',
        description: 'RFC 3339 Date Time'
      },
      locale: {
        type: 'string',
        description:
          'The locale the page was in at the time, which is not necessarily its locale now.'
      },
      path: {
        type: 'string',
        description: 'Where the page was at the time, which is not necessarily where it is now.'
      },
      title: {
        type: 'string'
      },
      author: {
        type: 'object',
        description: 'Who made the change. Null id and empty name once that account is deleted.',
        properties: {
          id: {
            type: ['string', 'null'],
            format: 'uuid'
          },
          name: {
            type: 'string'
          },
          email: {
            type: 'string'
          }
        }
      }
    }
  })

  /**
   * RECOVERABLE PAGE ENTRY - One recoverable deletion, as `GET .../pages/deleted` lists them
   *
   * Deliberately not `PageHistoryEntry` (OpenProject #2168): that listing spans every deleted path on
   * the site in one sweep rather than one page's own history, so `author.email` is left out here —
   * every deleter's email address at once is a wider exposure than this listing needs to serve its
   * purpose. `tags`/`classification` travel with a version too, unlike `PageHistoryEntry`, since a
   * caller acting on one of these rows may find them informative the same way the file manager does.
   */
  app.addSchema({
    $id: 'RecoverablePageEntry',
    type: 'object',
    properties: {
      id: {
        type: 'string',
        format: 'uuid'
      },
      action: {
        type: 'string',
        enum: [...pageHistoryActions],
        description: 'What happened to the page. Always `deleted` on this listing.'
      },
      via: {
        type: 'string',
        enum: [...pageHistoryVia]
      },
      changedFields: {
        type: 'array',
        items: { type: 'string' }
      },
      reason: {
        type: 'string'
      },
      versionDate: {
        type: 'string',
        format: 'date-time',
        description: 'RFC 3339 Date Time'
      },
      locale: {
        type: 'string',
        description: 'The locale the page was in when it was deleted.'
      },
      path: {
        type: 'string',
        description: 'Where the page was when it was deleted.'
      },
      title: {
        type: 'string'
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'The tags the deleted version carried.'
      },
      classification: {
        type: ['string', 'null'],
        format: 'uuid',
        description: 'The classification level id the deleted version carried.'
      },
      author: {
        type: 'object',
        description: 'Who deleted it. Null id and empty name once that account is deleted.',
        properties: {
          id: {
            type: ['string', 'null'],
            format: 'uuid'
          },
          name: {
            type: 'string'
          }
        }
      }
    }
  })

  /**
   * PAGE HISTORY LIST ENTRY - One version as the paginated history list reports it: the same as
   * PageHistoryEntry, but the author carries no email -- `list()` doesn't select it (see
   * `models/pageHistory.ts`'s `PageHistoryListAuthor`), since nothing reading a page's whole timeline
   * needs a contributor's address and there's no reason to hand hundreds of rows carrying one.
   */
  app.addSchema({
    $id: 'PageHistoryListEntry',
    type: 'object',
    properties: {
      id: {
        type: 'string',
        format: 'uuid'
      },
      action: {
        type: 'string',
        enum: [...pageHistoryActions],
        description: 'What happened to the page. `moved` is a change of path or title.'
      },
      via: {
        type: 'string',
        enum: [...pageHistoryVia],
        description:
          "What actually made the change: `editor` for the standard editor (every REST-API-driven save), or `mcp` for an MCP tool call acting on the author's behalf."
      },
      changedFields: {
        type: 'array',
        description:
          'Which page fields the change touched, named as the page stores them. Empty for a creation or a deletion, where the whole page is the change.',
        items: {
          type: 'string'
        }
      },
      reason: {
        type: 'string',
        description:
          "Why the change was made, in the author's words. Empty when the site does not ask for a reason — see the `reasonForChange` site feature — or asked and was not answered."
      },
      versionDate: {
        type: 'string',
        format: 'date-time',
        description: 'RFC 3339 Date Time'
      },
      locale: {
        type: 'string',
        description:
          'The locale the page was in at the time, which is not necessarily its locale now.'
      },
      path: {
        type: 'string',
        description: 'Where the page was at the time, which is not necessarily where it is now.'
      },
      title: {
        type: 'string'
      },
      author: {
        type: 'object',
        description: 'Who made the change. Null id and empty name once that account is deleted.',
        properties: {
          id: {
            type: ['string', 'null'],
            format: 'uuid'
          },
          name: {
            type: 'string'
          }
        }
      }
    }
  })

  /**
   * PAGE HISTORY LIST - One keyset-paginated page of a page's version history
   */
  app.addSchema({
    $id: 'PageHistoryList',
    type: 'object',
    properties: {
      items: {
        type: 'array',
        description: 'This page of versions, newest first.',
        items: { $ref: 'PageHistoryListEntry#' }
      },
      nextCursor: {
        type: ['string', 'null'],
        description: 'Pass back as `cursor` to fetch the next, older page. Null once there is none.'
      }
    }
  })

  /**
   * PAGE HISTORY VERSION - The same, with the source it held: one side of a diff
   */
  app.addSchema({
    $id: 'PageHistoryVersion',
    type: 'object',
    allOf: [
      { $ref: 'PageHistoryEntry#' },
      {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: 'The page source as of this version.'
          },
          meta: {
            // Deliberately loose: `pageHistory.ts`'s `record()` builds this by reflecting over every
            // column of the pages row not in `EXCLUDED_FROM_META`, so its keys track the pages table
            // schema rather than a fixed contract — pinning it here would drift out of sync the next
            // time a page column is added or removed.
            type: 'object',
            additionalProperties: true,
            description:
              'The rest of the page as it stood: description, icon, tags, publish state and dates, relations, scripts, config, editor and content type.'
          }
        }
      }
    ]
  })

  /**
   * PAGE HISTORY RECOVERABLE PAGE - One keyset page of `listRecoverable` results
   *
   * Wraps `RecoverablePageEntry`, not `PageHistoryEntry` (OpenProject #2168) -- see that schema's own
   * doc comment for why: `tags`/`classification` ride along and `author.email` is dropped, since this
   * listing spans every deleted path on the site in one sweep rather than one page's own history.
   */
  app.addSchema({
    $id: 'PageHistoryRecoverablePage',
    type: 'object',
    properties: {
      items: {
        type: 'array',
        description:
          'Recoverable deletions from this page of the scan, already filtered to rows the caller may read the history of — can be shorter than the requested `limit` even mid-list.',
        items: { $ref: 'RecoverablePageEntry#' }
      },
      nextCursor: {
        type: ['string', 'null'],
        description: 'Pass back as `cursor` to fetch the next page. Null once there is no more.'
      }
    }
  })

  /**
   * PAGE HISTORY RECOVER RESPONSE - A deleted page, recreated from one of its versions
   */
  app.addSchema({
    $id: 'PageHistoryRecoverResponse',
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      message: { type: 'string' },
      page: { $ref: 'Page#' }
    }
  })
}
