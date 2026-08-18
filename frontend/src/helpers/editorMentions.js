import { VueRenderer } from '@tiptap/vue-3'

import EditorMentionList from '@/components/EditorMentionList.vue'

/**
 * Builds the TipTap `suggestion` option that powers the WYSIWYG editor's `@` mention.
 *
 * Typing `@` opens a floating list of this site's pages, searched through
 * `GET /sites/:siteId/pages/search` -- the same full-text search `LinkPickerDialog`'s page tab and
 * the global search box already use, rather than standing up a second endpoint for the same thing.
 * (`/_api/users` was the other candidate the task pointed at, but that route requires the
 * `read:users`/`manage:users` GLOBAL permission -- an admin-only grant most editors do not hold --
 * so it cannot back a mention every writer is expected to be able to use.)
 *
 * @param {import('pinia').Store} siteStore Read lazily (`siteStore.id`, not a snapshotted value) so
 *   a suggestion opened before the site has finished loading still resolves against whichever site
 *   is current by the time a query actually fires.
 * @returns {object} The `suggestion` option for `Mention.configure({ suggestion })`.
 */
export function createPageMentionSuggestion(siteStore) {
  return {
    char: '@',
    // -> Waits for a pause in typing before hitting the search endpoint; `items()` below still
    //    short-circuits an empty query for free, this just spares mid-word keystrokes a request each.
    debounce: 250,

    /**
     * A blank query (just typed `@`, nothing after it) resolves with no items and no request --
     * `EditorMentionList` reads `query` itself to tell that apart from a real "nothing matched"
     * search and shows its own prompt instead of an empty list. A search that legitimately finds
     * nothing, or a request that fails outright, both resolve to `[]` too: from the popover's side
     * they are the same "no results" state, and either way it renders a message rather than nothing.
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
          // -> `id`/`label` are what the Mention node's default `command` copies onto the inserted
          //    node's attributes (`data-id` / `data-label`); the path makes a more useful `id` for a
          //    wiki page mention than the row's opaque database uuid would.
          id: page.path,
          label: page.title,
          path: page.path,
          icon: page.icon
        }))
      } catch {
        // -> Includes a request the plugin itself aborted because the query changed again -- the
        //    abort is detected by the plugin from `signal`/its own bookkeeping regardless of what is
        //    returned here, so resolving to `[]` rather than rethrowing keeps this branch simple
        //    without misrepresenting a superseded request as a resolved "no results" to the popover.
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
          // -> No `clientRect` means there is nowhere to anchor a popover -- happens converting the
          //    document to HTML outside a live view, per `SuggestionProps.clientRect`'s own doc.
          if (!props.clientRect) {
            return
          }
          unmount = props.mount(component.element)
        },
        onUpdate(props) {
          component.updateProps(props)
        },
        // -> Forwarded to the list component's own exposed handler for arrow/Enter navigation;
        //    Escape is handled by the suggestion plugin itself before this is ever asked.
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
