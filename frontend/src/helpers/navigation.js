import { pick } from 'es-toolkit/object'

/**
 * The menu editor holds a menu as a flat list so drag-reorder and the nested indicator can treat
 * every row alike, while the API speaks a nested shape — a top-level item carries its `children`
 * inline. These functions are the two directions of that translation.
 */

/**
 * `visibilityLimited` is derived here rather than read off the server: the server sends only the
 * groups themselves, and a non-empty array is what makes an item limiting.
 *
 * @param {object[]} out The flat array to push onto — mutated in place
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
      // -> Read-only display fields the server derives: carried onto the row for the editor's icon
      //    fallback, never sent back on save (see `cleanMenuItem`).
      'generated',
      'isFolder'
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
        'generated',
        'isFolder'
      ]),
      visibilityLimited: child.visibilityGroups?.length > 0,
      isNested: true
    })
  }
}

export function flattenMenuItems(items) {
  const out = []
  for (const item of items ?? []) {
    flattenMenuItem(item, out)
  }
  return out
}

/**
 * `children` and `expandByDefault` go on a `link` only when it is not itself nested: nesting is one
 * level deep, so a nested item carrying either would be a setting nothing reads.
 *
 * @param {'before'|'after'} [pinned] Placement relative to the generated block, on a `mixed` menu
 *   only. Never set on a nested item.
 * @returns {object|undefined} `undefined` for an unrecognized type
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
 * A `generated` item (and every nested child of one, always also `generated`) is dropped: `getNav`
 * rebuilds it from the tree on every read, so writing it back would freeze today's snapshot into
 * the stored `items` column.
 *
 * On a `mixed` menu a surviving top-level item's `pinned` is recomputed from where it now sits
 * rather than trusting what it loaded with: dragging cannot cross the generated block, but a stored
 * item can still move relative to other stored items on the same side, and a stale `pinned` would
 * silently revert that drag on save.
 *
 * @param {object} [opts]
 * @param {string} [opts.menuMode] The menu's source — `static`/`auto`/`mixed`
 * @throws {Error} If a nested item has no preceding top-level `link` to attach to — dropping or
 *   misfiling it would save a menu different from the one on screen
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
        // -> A code, not a translated string: this module stays free of app/i18n context, so its
        //    hosts map the code to their own message.
        throw new Error('ERR_NESTED_LINK_WITHOUT_PARENT')
      }
      out[out.length - 1].children.push(cleanMenuItem(item, true))
    } else {
      const pinned = menuMode === 'mixed' ? (sawGeneratedBlock ? 'after' : 'before') : undefined
      out.push(cleanMenuItem(item, false, pinned))
    }
  }
  return out
}
