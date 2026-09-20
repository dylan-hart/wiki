import { VueRenderer } from '@tiptap/vue-3'

import EditorMentionList from '@/components/EditorMentionList.vue'

/**
 * `@` mentions pages, not users: `/_api/users` requires the `read:users`/`manage:users` GLOBAL
 * permission, an admin-only grant most editors do not hold, so it cannot back a mention every
 * writer is expected to use. `pages/search` is the same full-text search the link picker and the
 * global search box already go through.
 *
 * @param {import('pinia').Store} siteStore Read lazily, so a suggestion opened before the site has
 *   loaded still resolves against whichever site is current when a query fires.
 */
export function createPageMentionSuggestion(siteStore) {
  return {
    char: '@',
    // -> Spares every mid-word keystroke its own search request.
    debounce: 250,

    /**
     * Every empty outcome -- blank query, no match, failed request -- resolves to `[]` rather than
     * throwing; `EditorMentionList` reads `query` itself to tell a blank query apart from a search
     * that matched nothing, so the popover always has something to render.
     */
    async items({ query, signal }) {
      const trimmed = query.trim()
      if (!trimmed || !siteStore.id) {
        return []
      }
      try {
        const response = await API_CLIENT.get(`sites/${siteStore.id}/pages/search`, {
          searchParams: { query: trimmed, limit: 5 },
          signal
        }).json()
        return (response?.results ?? []).map((page) => ({
          // -> `id`/`label` land on the inserted node as `data-id`/`data-label`, so the path is a
          //    more useful `id` for a page mention than the row's opaque uuid.
          id: page.path,
          label: page.title,
          path: page.path,
          icon: page.icon
        }))
      } catch {
        // -> Also catches a request the plugin aborted because the query moved on; it tracks that
        //    from `signal` itself, so `[]` here is not mistaken for a real "no results".
        return []
      }
    },

    render() {
      let component
      let unmount

      return {
        onStart(props) {
          component = new VueRenderer(EditorMentionList, {
            props,
            editor: props.editor
          })
          // -> No `clientRect` (converting the document to HTML outside a live view) means there is
          //    nowhere to anchor a popover.
          if (!props.clientRect) {
            return
          }
          unmount = props.mount(component.element)
        },
        onUpdate(props) {
          component.updateProps(props)
        },
        // -> Escape never reaches here: the suggestion plugin handles it first.
        onKeyDown(props) {
          return component.ref?.onKeyDown(props) ?? false
        },
        onExit() {
          unmount?.()
          component.destroy()
        }
      }
    }
  }
}
