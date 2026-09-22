import { findKey } from 'es-toolkit/object'

/**
 * A folder already in the map keeps the children collected for it so far — a lazy expansion of one
 * branch must not drop what a previous expansion of another already recorded under it.
 *
 * An entry's parent is the folder that was asked for; a request that asked for none (the initial
 * load, which brings back ancestors and root folders together) resolves it out of the same response
 * by the path the entry names.
 *
 * @param {object} treeNodes The `id -> node` map to merge into. Mutated.
 * @param {Array<object>} entries
 * @param {string|null} parentId The folder that was fetched, or null.
 * @returns {{ roots: string[] }} Root-level folders in this response, in the order they came back.
 */
export function mergeFolderEntries(treeNodes, entries, parentId) {
  const roots = []
  for (const item of entries ?? []) {
    if (item.type !== 'folder') {
      continue
    }

    treeNodes[item.id] = {
      folderPath: item.folderPath,
      fileName: item.fileName,
      title: item.title,
      children: treeNodes[item.id]?.children ?? []
    }

    if (item.folderPath) {
      let folderParentId = parentId
      if (!folderParentId) {
        const parentFolderParts = item.folderPath.split('/')
        const parentFolder = entries.find(
          (i) =>
            i.folderPath === parentFolderParts.slice(0, -1).join('/') &&
            i.fileName === parentFolderParts.at(-1)
        )
        folderParentId = parentFolder?.id
      }
      if (item.id !== folderParentId && !treeNodes[folderParentId]?.children?.includes(item.id)) {
        treeNodes[folderParentId]?.children?.push(item.id)
      }
    } else {
      roots.push(item.id)
    }
  }
  return { roots }
}

/**
 * The tree response carries no `parent` field, so the parent is found by scanning the map for the
 * entry whose `folderPath`/`fileName` spell this folder's own `folderPath`.
 *
 * `null` means both "already at the root" and "the folder above this one IS the root" -- the same
 * answer to a caller, which addresses the root as `null` anyway. Whether there is anywhere to go up
 * to is the caller's question, not this one's.
 *
 * @param {object} treeNodes The `id -> node` map, as `mergeFolderEntries` builds it.
 * @param {string|null} folderId
 * @returns {string|null}
 */
export function parentFolderIdOf(treeNodes, folderId) {
  const node = folderId ? treeNodes?.[folderId] : null
  if (!node?.folderPath) {
    return null
  }
  const parts = node.folderPath.split('/')
  const parentFolderPath = parts.slice(0, -1).join('/')
  const parentFileName = parts.at(-1)
  const entry = Object.entries(treeNodes).find(
    ([, candidate]) =>
      (candidate.folderPath ?? '') === parentFolderPath && candidate.fileName === parentFileName
  )
  return entry?.[0] ?? null
}

/**
 * Excludes `targetId`; empty when it is not in `nodes`, or is itself root-level.
 *
 * Walks each folder's `children` array rather than reusing `parentFolderIdOf`'s `folderPath`
 * parsing: both answer the same question over the same map, but a `children` walk needs no
 * `folderPath`/`fileName` populated, so a caller building nodes by hand only has to supply children.
 *
 * @param {object} nodes The `id -> node` map, as `mergeFolderEntries` builds it.
 * @param {string} targetId
 * @returns {string[]} Ancestor ids, outermost first.
 */
export function ancestorFolderIds(nodes, targetId) {
  const ids = []
  let currentId = targetId
  for (;;) {
    const parentId = findKey(nodes ?? {}, (node) => node.children?.includes(currentId))
    if (!parentId) {
      return ids
    }
    ids.unshift(parentId)
    currentId = parentId
  }
}

/**
 * Excludes `targetId`. The depth cap keeps an expand-cycle click on a huge already-loaded subtree
 * from walking and toggling all of it at once; the default matches `NavSidebarItem.vue`'s
 * `MAX_EXPAND_CYCLE_DEPTH`. An unfetched folder is indistinguishable from an empty one here (both
 * `children: []`), so a walk over an unfetched branch stops at its edge on its own.
 *
 * @param {object} nodes The `id -> node` map, as `mergeFolderEntries` builds it.
 * @param {string} targetId
 * @param {number} [maxDepth] Levels below `targetId` to descend.
 * @returns {string[]} Descendant folder ids, in walk order.
 */
export function descendantFolderIds(nodes, targetId, maxDepth = 3) {
  function walk(id, depth) {
    if (depth >= maxDepth) {
      return []
    }
    const ids = []
    for (const childId of nodes?.[id]?.children ?? []) {
      ids.push(childId, ...walk(childId, depth + 1))
    }
    return ids
  }
  return walk(targetId, 0)
}

/**
 * `initLoad` also asks for the folders above the one being listed, so opening on a page buried a few
 * levels down draws its whole branch from one request. Those extras come back flagged `isAncestor`
 * and belong in the tree only, never in the list beside it.
 *
 * @param {string} siteId
 * @param {object} [params]
 * @param {string|null} [params.parentId] The folder to list, or null for the root.
 * @param {string|null} [params.parentPath] The same folder, addressed by path instead.
 * @param {string[]|null} [params.types] Entry types to ask for; omitted asks for all of them.
 * @param {string|null} [params.locale]
 * @param {boolean} [params.initLoad]
 * @returns {Promise<Array<object>>}
 */
export function fetchTreeEntries(
  siteId,
  {
    parentId = null,
    parentPath = null,
    types = null,
    locale = null,
    initLoad = false,
    orderBy = 'sortOrder'
  } = {}
) {
  return API_CLIENT.get(`sites/${siteId}/tree`, {
    searchParams: {
      orderBy,
      ...(parentId ? { parentId } : {}),
      ...(parentPath ? { parentPath } : {}),
      ...(types?.length > 0 ? { types: types.join(',') } : {}),
      ...(locale ? { locale } : {}),
      includeAncestors: initLoad,
      includeRootFolders: initLoad
    }
  }).json()
}

function groupByFileName(entries) {
  const units = new Map()
  for (const entry of entries ?? []) {
    if (entry.type === 'asset') {
      continue
    }
    const unit = units.get(entry.fileName)
    if (unit) {
      unit.push(entry)
    } else {
      units.set(entry.fileName, [entry])
    }
  }
  return [...units.values()]
}

export function reorderableIds(entries) {
  return groupByFileName(entries).flatMap((unit) => unit.map((entry) => entry.id))
}

export function idsWithFolderOrder(entries, folderIds) {
  const units = groupByFileName(entries)
  const folderUnits = units.filter((unit) => unit.some((entry) => entry.type === 'folder'))
  const ordered = []
  for (const folderId of folderIds) {
    const unit = folderUnits.find((candidate) => candidate.some((entry) => entry.id === folderId))
    if (unit && !ordered.includes(unit)) {
      ordered.push(unit)
    }
  }
  ordered.push(...folderUnits.filter((unit) => !ordered.includes(unit)))

  let next = 0
  return units.flatMap((unit) =>
    (folderUnits.includes(unit) ? ordered[next++] : unit).map((entry) => entry.id)
  )
}

export function orderLike(ids, order) {
  const wanted = order.filter((id) => ids.includes(id))
  return [...wanted, ...ids.filter((id) => !wanted.includes(id))]
}

export function reorderTreeEntries(siteId, { parentId = null, locale = null, ids }) {
  return API_CLIENT.put(`sites/${siteId}/tree/order`, {
    json: {
      ...(parentId ? { parentId } : {}),
      ...(locale ? { locale } : {}),
      ids
    }
  }).json()
}
