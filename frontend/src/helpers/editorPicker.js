import { dialog } from '@/composables/dialog'

import EditorPickerDialog from '@/components/EditorPickerDialog.vue'

/**
 * The content-type editors `EditorPickerDialog` offers, in the same order `AdminEditors.vue` lists
 * them. `redirect` is deliberately left out: it authors no content, so it is not one of the "what
 * kind of page" choices this decides between -- every entry point that wants a redirection (see
 * `PageNewMenu.vue`) asks for it directly, with no picker in the way.
 */
export const PICKABLE_EDITORS = ['asciidoc', 'code', 'markdown', 'wysiwyg']

/**
 * Asks the reader which editor a new page should open in.
 *
 * Skips the dialog entirely when there is only one real choice -- with a single editor active,
 * asking would be a click for an answer that was never in doubt, which is the opposite of what a
 * picker is for. Falls back to `markdown` on the (currently unreachable, since `AdminEditors.vue`
 * cannot fully disable it) chance a site has none active at all: a picker with nothing to list is
 * worse than a page that opens in markdown.
 *
 * @param {import('pinia').Store} siteStore Read for its current `editors` map. Callers that also
 *   need `editorStore.fetchConfigs()` (as `pageStore.pageCreate` does) should resolve that first --
 *   this only reads `siteStore.editors`, which `applySiteInfo`/`loadSite` populate on their own.
 * @param {Function} [dialogFn] The `dialog()` opener, injected so a test can stub it without
 *   mounting the real dialog component.
 * @returns {Promise<string|null>} The chosen editor id, or `null` if the picker was dismissed
 *   without a choice.
 */
export async function pickEditor(siteStore, dialogFn = dialog) {
  const active = PICKABLE_EDITORS.filter((id) => siteStore.editors?.[id])

  if (active.length <= 1) {
    return active[0] ?? 'markdown'
  }

  return new Promise((resolve) => {
    dialogFn({ component: EditorPickerDialog })
      .onOk(({ editor }) => resolve(editor))
      .onCancel(() => resolve(null))
  })
}
