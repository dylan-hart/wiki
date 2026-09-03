import { html } from 'lit'

import { inlineIcon, MDI_PATHS } from '../shared/icons.js'

/**
 * `block-pdf`'s toolbar, split out of `component.js` (BLK-F9).
 *
 * A pure function of the viewer's state, not a second component: it draws into the same shadow root
 * as the rest of the block (`./styles.js` styles it) and owns nothing -- every control hands back to
 * a method on the element. The split is for `component.js`'s size, and because the toolbar's markup
 * has no bearing on the render engine it used to sit in the middle of.
 */

/** The zoom steps, and so also what the toolbar's list offers besides the two fitting modes. */
export const ZOOM_LEVELS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3]

/**
 * @param {object} state
 * @param {number} state.currentPage The page the viewer is showing, 1-based.
 * @param {number} state.pageCount How many pages the document has; 0 before it has loaded.
 * @param {number} state.scale The scale the pages are actually drawn at, for the zoom buttons'
 *   disabled states.
 * @param {string} state.zoomValue What the zoom list is set to -- `page-width`, `page-fit`, or a
 *   percentage as it is written in the list.
 * @param {string} state.src The document's own address, for the "open in a new tab" link.
 * @param {object} handlers One per control, bound by the element that owns them.
 */
export function renderToolbar(state, handlers) {
  return html`
    <div class="toolbar">
      <div class="pager">
        <button
          class="tool"
          type="button"
          title="Previous page"
          aria-label="Previous page"
          ?disabled=${state.currentPage <= 1}
          @click=${handlers.onPreviousPage}>
          ${inlineIcon(MDI_PATHS.previous)}
        </button>
        <input
          type="number"
          min="1"
          max=${state.pageCount}
          aria-label="Page number"
          .value=${String(state.currentPage)}
          @change=${handlers.onPageInput} />
        <span>/ ${state.pageCount || '—'}</span>
        <button
          class="tool"
          type="button"
          title="Next page"
          aria-label="Next page"
          ?disabled=${state.currentPage >= state.pageCount}
          @click=${handlers.onNextPage}>
          ${inlineIcon(MDI_PATHS.next)}
        </button>
      </div>

      <span class="spacer"></span>

      <button
        class="tool"
        type="button"
        title="Zoom out"
        aria-label="Zoom out"
        ?disabled=${state.scale <= ZOOM_LEVELS[0]}
        @click=${handlers.onZoomOut}>
        ${inlineIcon(MDI_PATHS.zoomOut)}
      </button>
      <!--
        -> Which one is showing is set on the options rather than on the select: Lit writes an
           attribute or property on an element before it fills in its children, so a .value binding here
           would be assigned while the list is still empty and come back as nothing.
      -->
      <select aria-label="Zoom" @change=${handlers.onZoomSelect}>
        <option value="page-width" .selected=${state.zoomValue === 'page-width'}>Fit width</option>
        <option value="page-fit" .selected=${state.zoomValue === 'page-fit'}>Fit page</option>
        ${ZOOM_LEVELS.map(
          (level) => html`
            <option value="${level * 100}%" .selected=${state.zoomValue === `${level * 100}%`}>
              ${level * 100}%
            </option>
          `
        )}
      </select>
      <button
        class="tool"
        type="button"
        title="Zoom in"
        aria-label="Zoom in"
        ?disabled=${state.scale >= ZOOM_LEVELS.at(-1)}
        @click=${handlers.onZoomIn}>
        ${inlineIcon(MDI_PATHS.zoomIn)}
      </button>

      <span class="spacer"></span>

      <a
        class="tool"
        href=${state.src}
        target="_blank"
        rel="noopener noreferrer"
        title="Open in a new tab"
        aria-label="Open in a new tab">
        ${inlineIcon(MDI_PATHS.open)}
      </a>
    </div>
  `
}
