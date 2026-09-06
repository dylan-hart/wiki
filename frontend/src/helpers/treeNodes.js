/**
 * The folder tree behind the three browsers that read it — `FileManager.vue`,
 * `TreeBrowserDialog.vue` and `LinkPickerDialog.vue`.
 *
 * All three walk the same `GET sites/:id/tree` response and fold its folder entries into the same
 * `{ [id]: { folderPath, fileName, title, children } }` map, then project the same entries into a
 * list of their own — which is the part that genuinely differs (the File Manager lists folders,
 * assets and pages with sizes and dates; the save dialog lists folders and pages; the link picker
 * lists them sorted with icons). Only the shared half lives here: the request, and the merge.
 */

/**
 * Fold a tree response's folder entries into `treeNodes`, in place.
 *
 * A folder already in the map keeps the children collected for it so far — a lazy expansion of one
 * branch must not drop what a previous expansion of another already recorded under it.
 *
 * The parent of an entry is the folder that was asked for, when one was; a request that asked for
 * none (the initial load, which brings back ancestors and root folders together) resolves each
 * entry's parent out of the same response by the path it names.
 *
 * @param {object} treeNodes The `id -> node` map to merge into. Mutated.
 * @param {Array<object>} entries The tree response.
 * @param {string|null} parentId The folder that was fetched, or null.
 * @returns {{ roots: string[] }} The root-level folders this response carried, in the order they
 *   came back — the caller decides whether that replaces the roots it holds or adds to them.
 */
export function mergeFolderEntries(treeNodes, entries, parentId) {
  const roots = []
  for (const item of entries ?? []) {
    if (item.type !== 'folder') {
      continue
    }

    // -> Tree Nodes
    treeNodes[item.id] = {
      folderPath: item.folderPath,
      fileName: item.fileName,
      title: item.title,
      children: treeNodes[item.id]?.children ?? []
    }

    // -> Set Ancestors / Tree Roots
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
 * The folder one level above `folderId`, addressed the way the tree map addresses folders.
 *
 * A folder's own `folderPath` already names its parent: the folder at `docs/setup` has a parent whose
 * own `folderPath` is `docs`'s parent path (`''`) and whose `fileName` is `docs`. So the lookup is a
 * scan of the same map for the entry that spells that path -- there is no `parent` field to read,
 * since the tree response does not carry one.
 *
 * `null` covers both "already at the root" and "the folder directly above this one IS the root" --
 * which is the same answer as far as a caller is concerned, since `null` is what every browser here
 * already uses for the root folder. Whether there is anywhere to go up TO is the caller's own
 * question (it knows whether it is at the root), not this one's.
 *
 * @param {object} treeNodes The `id -> node` map, as `mergeFolderEntries` builds it.
 * @param {string|null} folderId The folder to find the parent of.
 * @returns {string|null} The parent folder's id, or `null` for the root.
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
 * One folder's worth of tree, as the API returns it.
 *
 * `initLoad` also asks for the folders above the one being listed, so that opening on a page buried
 * a few levels down draws its whole branch from a single request. Those extra entries come back
 * flagged `isAncestor` and belong in the tree only, never in the list beside it.
 *
 * @param {string} siteId
 * @param {object} [params]
 * @param {string|null} [params.parentId] The folder to list, or null for the root.
 * @param {string|null} [params.parentPath] The folder to list, addressed by path instead.
 * @param {string[]|null} [params.types] Entry types to ask for; omitted asks for all of them.
 * @param {string|null} [params.locale] The content locale to browse.
 * @param {boolean} [params.initLoad] Also bring back ancestors and root folders.
 * @returns {Promise<Array<object>>} The tree entries.
 */
export function fetchTreeEntries(
  siteId,
  { parentId = null, parentPath = null, types = null, locale = null, initLoad = false } = {}
) {
  return API_CLIENT.get(`sites/${siteId}/tree`, {
    searchParams: {
      ...(parentId ? { parentId } : {}),
      ...(parentPath ? { parentPath } : {}),
      ...(types?.length > 0 ? { types: types.join(',') } : {}),
      ...(locale ? { locale } : {}),
      includeAncestors: initLoad,
      includeRootFolders: initLoad
    }
  }).json()
}
