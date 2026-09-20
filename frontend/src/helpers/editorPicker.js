import { dialog } from '@/composables/dialog'

import EditorPickerDialog from '@/components/EditorPickerDialog.vue'

/**
 * `redirect` is deliberately left out: it authors no content, so it is not one of the "what kind of
 * page" choices this decides between -- entry points that want a redirection ask for it directly.
 */
export const PICKABLE_EDITORS = ['asciidoc', 'code', 'markdown', 'wysiwyg']

/**
 * Skips the dialog when there is only one active editor: asking would be a click for an answer
 * that was never in doubt. Falls back to `markdown` when a site has none at all, since a picker
 * with nothing to list is worse than a page that opens in markdown.
 *
 * @param {import('pinia').Store} siteStore Read for its current `editors` map.
 * @param {Function} [dialogFn] Injected so a test can stub it without mounting the real dialog.
 * @returns {Promise<string|null>} `null` if the picker was dismissed without a choice.
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
