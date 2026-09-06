import { LitElement, html, css } from 'lit'
import { renderError } from '../shared/render.js'
import { errorBox } from '../shared/styles.js'
import { DarkMode } from '../shared/theme.js'
import { getCurrentPageAccess } from '../shared/site.js'

/**
 * Renders an ISO timestamp the way a reader wants to see it. Plain `Date`/`Intl`, not `Temporal`:
 * this is display formatting of an already-resolved instant from the API, not date arithmetic, and
 * `Temporal` is a frontend-boot polyfill (`frontend/src/boot/temporal.js`) this block cannot assume
 * is loaded — a block runs wherever its tag turns up on a page, with no boot sequence of its own.
 */
function formatInstant(iso) {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/**
 * Block Checklist (OpenProject #869)
 *
 * A run-log checklist, not a markdown task list — existing `- [ ]` syntax is untouched and stays a
 * plain, unattributed rendering concern. Checking an item off here calls the backend
 * (`/_api/sites/:siteId/pages/:pageId/checklist/:runKey/...`), which records who checked it and when
 * in a durable run log, gated on the normal `write:pages` page-rule permission.
 *
 * Items come from the block's own light DOM — a markdown bullet list nested inside `::block-checklist`
 * renders to real `<li>`s before this element ever sees them (MDC parses a block's body as markdown),
 * so `connectedCallback` reads them out the same way `block-gallery` reads its own body. Each item's
 * key is its position (`item-0`, `item-1`, ...): stable across an ordinary re-render, not across the
 * author reordering or adding/removing items mid-run — seeing history split across a content edit
 * that changed the list is an accepted trade for not inventing a separate stable-id syntax authors
 * would have to write by hand. `models/checklists.ts`'s own doc comment says the same.
 */
export class BlockChecklistElement extends LitElement {
  /**
   * Metadata for the admin area and the editor's block picker. Collected at build time into
   * `compiled/blocks.manifest.json`, which the server reads to register the block. Values must be
   * plain literals. See `props` in `block-index` for what the picker does with that list.
   */
  static definition = {
    block: 'checklist',
    name: 'Checklist',
    description:
      'A run-log checklist — checking an item off records who checked it and when, per run.',
    icon: 'tabler:checklist',
    props: [
      {
        name: 'run-key',
        type: 'string',
        label: 'Run Key',
        hint: "This checklist's run log identity. Keep it the same across page edits — changing it starts a brand new, empty log.",
        required: true
      },
      {
        name: 'heading',
        type: 'string',
        label: 'Heading',
        hint: 'Shown above the checklist.'
      }
    ],
    template: `- First step
- Second step`
  }

  static get styles() {
    return [
      errorBox,
      css`
        :host {
          display: block;
        }

        .checklist,
        .error {
          margin-bottom: 16px;
        }

        .checklist {
          border: 1px solid rgba(0, 0, 0, 0.1);
          border-radius: 5px;
          padding: 1rem;
        }
        :host([dark]) .checklist {
          border-color: rgba(255, 255, 255, 0.15);
        }

        .heading {
          font-weight: 500;
          font-size: 1.1em;
          margin-bottom: 0.5rem;
        }

        .summary {
          font-size: 0.85em;
          opacity: 0.75;
          margin-bottom: 0.75rem;
        }
        .summary.completed {
          color: var(--q-positive, #21ba45);
          opacity: 1;
          font-weight: 500;
        }

        ul {
          list-style: none;
          margin: 0;
          padding: 0;
          display: flex;
          flex-direction: column;
          gap: 0.6rem;
        }

        li {
          display: flex;
          align-items: flex-start;
          gap: 0.6rem;
        }

        input[type='checkbox'] {
          margin-top: 0.2rem;
          width: 1.1rem;
          height: 1.1rem;
          flex: none;
          accent-color: var(--q-primary, #1976d2);
        }

        .label.checked {
          text-decoration: line-through;
          opacity: 0.7;
        }

        .meta {
          font-size: 0.75em;
          opacity: 0.65;
        }

        .history-toggle {
          margin-top: 0.75rem;
          background: none;
          border: none;
          padding: 0;
          font: inherit;
          font-size: 0.8em;
          color: var(--q-primary, #1976d2);
          cursor: pointer;
        }

        .history {
          margin-top: 0.6rem;
          padding-top: 0.6rem;
          border-top: 1px solid rgba(0, 0, 0, 0.1);
          gap: 0.4rem;
        }
        :host([dark]) .history {
          border-color: rgba(255, 255, 255, 0.15);
        }

        .history li {
          font-size: 0.8em;
          opacity: 0.85;
        }
      `
    ]
  }

  static get properties() {
    return {
      /**
       * This checklist's run log identity.
       *
       * -> Explicit `attribute`, because Lit's default (a bare lowercasing of the property name, no
       *    dash inserted) would listen for `runkey` while the block picker — which writes the literal
       *    `static definition.props[].name`, `run-key` — writes `run-key` into the page.
       * @type {string}
       */
      runKey: { type: String, attribute: 'run-key' },

      /** Shown above the checklist. @type {string} */
      heading: { type: String },

      // Internal properties
      _items: { state: true },
      _execution: { state: true },
      _loading: { state: true },
      _error: { state: true },
      _pending: { state: true },
      _historyOpen: { state: true },
      _history: { state: true },
      _historyLoading: { state: true },
      _canCheck: { state: true }
    }
  }

  constructor() {
    super()
    this.runKey = ''
    this.heading = ''
    this._items = []
    this._execution = null
    this._loading = true
    this._error = ''
    this._pending = new Set()
    this._historyOpen = false
    // -> `null` means "not fetched yet", told apart from an empty array (fetched, no runs at all).
    this._history = null
    this._historyLoading = false
    // -> Resolved by `_load()`, off the same public route the page view itself loads a page
    //    through -- see `../shared/site.js`'s header. False until then, same fail-closed default a
    //    missing `WIKI_STATE` used to leave this in.
    this._canCheck = false
    this._siteId = null
    this._pageId = null
    // -> Puts `dark` on this element for the styles above to key off
    this._darkMode = new DarkMode(this)
  }

  connectedCallback() {
    super.connectedCallback()
    this._items = [...this.querySelectorAll('li')].map((li, index) => ({
      key: `item-${index}`,
      label: li.textContent.trim()
    }))
    this._load()
  }

  /**
   * Client-side convenience only — the actual gate is the server's own `write:pages` check on every
   * POST, which runs regardless of what this returns. Hiding a control this can't back up would be
   * worse than showing one the request then refuses.
   */
  get _basePath() {
    return `/_api/sites/${this._siteId}/pages/${this._pageId}/checklist/${encodeURIComponent(this.runKey)}`
  }

  async _load() {
    const runKey = this.runKey?.trim()
    if (!runKey) {
      this._error = 'This checklist has no Run Key set.'
      this._loading = false
      return
    }
    if (this._items.length === 0) {
      this._error = 'This checklist has no items.'
      this._loading = false
      return
    }
    // -> No siteId/pageId threaded down to this block -- see `../shared/site.js`'s header for the
    //    convention (`getCurrentPageAccess`) that resolves both, plus this reader's own page-rule
    //    permissions on this page, off the public route the page view itself loads a page through.
    const { siteId, pageId, permissions } = await getCurrentPageAccess()
    this._siteId = siteId
    this._pageId = pageId
    this._canCheck = permissions.includes('write:pages')
    if (!siteId || !pageId) {
      this._error = 'This checklist’s run log could not be loaded.'
      this._loading = false
      return
    }
    try {
      const resp = await fetch(`${this._basePath}/executions/latest`)
      if (!resp.ok) {
        throw new Error(`Request failed (${resp.status}).`)
      }
      this._execution = await resp.json()
    } catch {
      this._error = 'This checklist’s run log could not be loaded.'
    }
    this._loading = false
  }

  _checkOf(key) {
    return this._execution?.items?.find((item) => item.itemKey === key) ?? null
  }

  /**
   * Checks one item, starting a new execution on the server first if none is currently active. A
   * no-op for an item already checked, one mid-flight, or a reader with no `write:pages` — the
   * checkbox itself is disabled in every one of those cases, but this guards the handler too, since
   * a change event can still fire on a checkbox a fast double-click raced past its own re-render.
   */
  async _check(key) {
    if (!this._canCheck || this._checkOf(key) || this._pending.has(key)) {
      return
    }
    this._pending = new Set(this._pending).add(key)
    try {
      const resp = await fetch(`${this._basePath}/items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemKey: key, itemCount: this._items.length })
      })
      if (!resp.ok) {
        throw new Error(`Request failed (${resp.status}).`)
      }
      this._execution = await resp.json()
      this._error = ''
    } catch {
      this._error = 'Could not record this check — try again.'
    } finally {
      const next = new Set(this._pending)
      next.delete(key)
      this._pending = next
    }
  }

  /**
   * Opens or closes the run history — the per-execution view the spec calls for ("run started at X,
   * completed by Y, N of M items checked"), one row per past run. Fetched once, lazily, and cached
   * for the life of this element: a run log an author is reviewing does not change out from under
   * them mid-read, and re-fetching on every toggle would only cost a round trip for no benefit.
   */
  async _toggleHistory() {
    this._historyOpen = !this._historyOpen
    if (!this._historyOpen || this._history !== null) {
      return
    }
    this._historyLoading = true
    try {
      const resp = await fetch(`${this._basePath}/executions`)
      if (!resp.ok) {
        throw new Error(`Request failed (${resp.status}).`)
      }
      this._history = await resp.json()
    } catch {
      this._history = []
      this._error = 'The run history could not be loaded.'
    }
    this._historyLoading = false
  }

  _renderHistoryRow(execution) {
    const status = execution.completedAt
      ? html`completed by ${execution.completedByName ?? 'someone'} at
        ${formatInstant(execution.completedAt)}`
      : html`in progress`
    return html`
      <li>
        Started by ${execution.startedByName ?? 'someone'} at ${formatInstant(execution.startedAt)}
        — ${execution.checkedCount} of ${execution.itemCount} checked, ${status}
      </li>
    `
  }

  _renderHistory() {
    if (!this._historyOpen) {
      return null
    }
    if (this._historyLoading) {
      return html`<div class="history">Loading…</div>`
    }
    if (!this._history || this._history.length === 0) {
      return html`<div class="history">No previous runs.</div>`
    }
    return html`<ul class="history">
      ${this._history.map((execution) => this._renderHistoryRow(execution))}
    </ul>`
  }

  _renderSummary() {
    if (!this._execution) {
      return html`Not started yet — ${this._items.length} item${this._items.length === 1 ? '' : 's'}`
    }
    const checkedCount = this._execution.checkedCount ?? 0
    if (this._execution.completedAt) {
      return html`Completed by ${this._execution.completedByName ?? 'someone'} at
      ${formatInstant(this._execution.completedAt)}`
    }
    return html`Started by ${this._execution.startedByName ?? 'someone'} at
    ${formatInstant(this._execution.startedAt)} — ${checkedCount} of ${this._items.length} checked`
  }

  _renderItem(item) {
    const check = this._checkOf(item.key)
    const pending = this._pending.has(item.key)
    return html`
      <li>
        <input
          type="checkbox"
          .checked=${Boolean(check)}
          ?disabled=${Boolean(check) || pending || !this._canCheck}
          aria-label=${item.label}
          @change=${() => this._check(item.key)} />
        <div>
          <div class="label ${check ? 'checked' : ''}">${item.label}</div>
          ${
            check
              ? html`<div class="meta">
                  ${check.checkedByName ?? 'Someone'} · ${formatInstant(check.checkedAt)}
                </div>`
              : null
          }
        </div>
      </li>
    `
  }

  render() {
    if (this._loading) {
      return null
    }
    if (this._error) {
      return renderError(this._error)
    }
    return html`
      <div class="checklist">
        ${this.heading ? html`<div class="heading">${this.heading}</div>` : null}
        <div class="summary ${this._execution?.completedAt ? 'completed' : ''}">
          ${this._renderSummary()}
        </div>
        <ul>
          ${this._items.map((item) => this._renderItem(item))}
        </ul>
        <button type="button" class="history-toggle" @click=${() => this._toggleHistory()}>
          ${this._historyOpen ? 'Hide run history' : 'View run history'}
        </button>
        ${this._renderHistory()}
      </div>
    `
  }
}

window.customElements.define('block-checklist', BlockChecklistElement)
