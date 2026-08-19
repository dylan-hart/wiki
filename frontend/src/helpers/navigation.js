import { pick } from 'es-toolkit/object'

/**
 * Pure data-shaping logic for `NavItemEditor.vue`'s menu editor (the item-list-plus-detail-panel
 * shared by `NavEditOverlay.vue`'s per-page editing and `AdminNavigation.vue`'s site-wide editing).
 *
 * The editor keeps the menu it edits as a flat list (`state.items`) so drag-reorder and the nested
 * indicator can treat every row the same way, while the API speaks a nested shape — a top-level item
 * carries its `children` inline. These functions are the two directions of that translation, plus the
 * per-item field whitelist both directions share. None of them touch Vue reactivity, the DOM, or
 * component state — they take and return plain objects, which is what makes them testable without
 * mounting the component.
 */

/**
 * Flattens one server-shaped menu item — and its nested `children`, if any — onto a flat array.
 *
 * Mirrors the loop in `loadMenuItems()`: a top-level item is pushed first, then each of its children
 * immediately after with `isNested: true`. `visibilityLimited` is derived here rather than read off
 * the server, because the server only ever sends the groups themselves — whether they're limiting is
 * implied by the array being non-empty.
 *
 * @param {object} item A server-shaped menu item, possibly carrying a `children` array
 * @param {object[]} out The flat array to push onto — mutated in place, matching the call site's loop
 */
export function flattenMenuItem(item, out) {
  out.push({
    ...pick(item, [
      'id',
      'type',
      'label',
      'icon',
      'target',
      'openInNewWindow',
      'expandByDefault',
      'visibilityGroups',
      // -> `getNav`-only, never sent back on save — see `cleanMenuItem`/`reconstructMenuItems`
      'generated'
    ]),
    visibilityLimited: item.visibilityGroups?.length > 0
  })
  for (const child of item?.children ?? []) {
    out.push({
      ...pick(child, [
        'id',
        'type',
        'label',
        'icon',
        'target',
        'openInNewWindow',
        'visibilityGroups',
        'generated'
      ]),
      visibilityLimited: child.visibilityGroups?.length > 0,
      isNested: true
    })
  }
}

/**
 * Flattens a whole server-shaped menu (top-level items, each possibly carrying `children`) into the
 * flat array shape `state.items` holds.
 *
 * @param {object[]} items The server response — top-level menu items
 * @returns {object[]} The flat, editor-shaped list
 */
export function flattenMenuItems(items) {
  const out = []
  for (const item of items ?? []) {
    flattenMenuItem(item, out)
  }
  return out
}

/**
 * The save-shaped form of one editor row: the type-dependent field whitelist, with
 * `visibilityGroups` cleared unless the item is actually visibility-limited.
 *
 * `children` and `expandByDefault` are attached to a `link` only when it is NOT itself nested — only
 * a top-level link can hold children, so only one of those can be a parent, and a nested item
 * carrying an expand flag would be a setting nothing ever reads.
 *
 * @param {object} item An editor-shaped row from `state.items`
 * @param {boolean} [isNested] Whether this row is itself a nested child
 * @param {'before'|'after'} [pinned] A `mixed`-menu top-level item's placement relative to the
 *   generated block — see `reconstructMenuItems`. Never set on a nested item.
 * @returns {object|undefined} The save-shaped item, or `undefined` for an unrecognized type
 */
export function cleanMenuItem(item, isNested = false, pinned) {
  switch (item.type) {
    case 'header': {
      return {
        ...pick(item, ['id', 'type', 'label']),
        visibilityGroups: item.visibilityLimited ? item.visibilityGroups : [],
        ...(pinned && { pinned })
      }
    }
    case 'link': {
      return {
        ...pick(item, ['id', 'type', 'label', 'icon', 'target', 'openInNewWindow']),
        visibilityGroups: item.visibilityLimited ? item.visibilityGroups : [],
        ...(!isNested && { children: [], expandByDefault: Boolean(item.expandByDefault) }),
        ...(pinned && { pinned })
      }
    }
    case 'separator': {
      return {
        ...pick(item, ['id', 'type', 'label', 'icon', 'target', 'openInNewWindow']),
        visibilityGroups: item.visibilityLimited ? item.visibilityGroups : [],
        ...(pinned && { pinned })
      }
    }
  }
}

/**
 * Reconstructs the flat editor list (`state.items`) back into the nested, save-shaped menu the API
 * expects.
 *
 * Mirrors the loop in `save()`: a non-nested row starts a new top-level item, and a nested row is
 * appended to the most recently pushed item's `children`. A nested row with no preceding top-level
 * `link` — the list starts nested, or a nested row follows a header/separator — cannot be attached to
 * anything, and is the one case this raises on rather than silently drops or misfiles, since either of
 * those would save a menu different from the one on screen.
 *
 * A `generated` item (and every nested child of one — always also `generated`, see `markGenerated` on
 * the server) is skipped entirely: it is not this menu's own, `getNav` builds it fresh from the tree on
 * every read, and writing it back would freeze today's snapshot into the stored `items` column exactly
 * as the merge-rule note on the server's `getNav` warns against.
 *
 * On a `mixed` menu, a surviving top-level item's own `pinned` is recomputed from where it currently
 * sits relative to the generated block, rather than trusting whatever it loaded with: dragging is
 * fenced off from crossing that block (see `NavItemEditor.vue`'s `sortableOptions`), but a stored item
 * can still move relative to OTHER stored items on the same side, and this is what keeps a save from
 * silently reverting a drag the fence allowed.
 *
 * @param {object[]} items The flat, editor-shaped list (`state.items`)
 * @param {object} [opts]
 * @param {string} [opts.menuMode] The resolved menu's own source (`static`/`auto`/`mixed`) — only a
 *   `mixed` menu computes `pinned` on its surviving top-level items.
 * @returns {object[]} The nested, save-shaped menu
 * @throws {Error} If a nested item has no preceding top-level `link` to attach to
 */
export function reconstructMenuItems(items, { menuMode } = {}) {
  const out = []
  let sawGeneratedBlock = false
  for (const item of items) {
    if (item.generated) {
      sawGeneratedBlock = true
      continue
    }
    if (item.isNested) {
      if (out.length < 1 || out.at(-1)?.type !== 'link') {
        throw new Error('One or more nested link items are not under a parent link!')
      }
      // -> `pinned` is a top-level-only placement, meaningless (and never set) on a nested item
      out[out.length - 1].children.push(cleanMenuItem(item, true))
    } else {
      const pinned = menuMode === 'mixed' ? (sawGeneratedBlock ? 'after' : 'before') : undefined
      out.push(cleanMenuItem(item, false, pinned))
    }
  }
  return out
}
