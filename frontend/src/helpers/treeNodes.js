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
