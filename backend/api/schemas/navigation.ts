import type { FastifyInstance } from 'fastify'

export async function registerSchemas(app: FastifyInstance): Promise<void> {
  /**
   * NAVIGATION ITEM - Shared rather than inlined per route so `children` can `$ref` itself: a
   * plain object literal has no way to nest arbitrarily deep, which silently truncated a menu to
   * two levels regardless of what the tree walk or the stored items actually held (OpenProject
   * #814 follow-up).
   */
  app.addSchema({
    $id: 'NavigationItem',
    type: 'object',
    properties: {
      id: { type: 'string' },
      type: { type: 'string', enum: ['link', 'header', 'separator'] },
      label: { type: 'string' },
      icon: { type: 'string' },
      target: { type: 'string' },
      path: {
        type: 'string',
        readOnly: true,
        description:
          'Generated items only: the raw tree path this item belongs to, no locale prefix. Never sent in a request body — computed fresh on every read, same as `generated`.'
      },
      folderId: {
        type: 'string',
        nullable: true,
        readOnly: true,
        description:
          'Generated items only: the tree-row id of the folder containing this item, or null at locale root. Never sent in a request body.'
      },
      openInNewWindow: { type: 'boolean' },
      expandByDefault: {
        type: 'boolean',
        description:
          'Whether a link holding children is shown expanded on load. Meaningless on any other item.'
      },
      visibilityGroups: {
        type: 'array',
        items: { type: 'string' },
        description: 'Groups the item is limited to. Visible to everyone when empty.'
      },
      children: {
        type: 'array',
        items: { $ref: 'NavigationItem#' }
      },
      pinned: {
        type: 'string',
        enum: ['before', 'after'],
        description:
          "`mixed` menus only: whether a stored top-level item is placed before or after the tree-generated items it is merged with. Meaningless on `static`/`auto` menus and on nested items. Anything other than 'before' (including absent) is treated as 'after'."
      },
      generated: {
        type: 'boolean',
        readOnly: true,
        description:
          "Set by the server on an `auto`/`mixed` menu for every item (and nested child) that came from the tree walk rather than the stored items — never sent in a request body, since it is derived fresh on every read, not stored. Absent on a `static` menu and on a `mixed` menu's own stored items."
      }
    }
  })
}
