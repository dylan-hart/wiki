import { log } from '@/helpers/log'

/**
 * What to call the component an uncaught error came out of.
 *
 * Three sources, in the order they are worth having: an explicitly declared `name`, then the
 * filename-derived `__name` the SFC compiler stamps onto a `<script setup>` component (which is
 * every component in this app that has not declared one), then nothing — an inline object component,
 * a render function, or a handler that fired with no component instance attached at all.
 *
 * @param {object} [instance] The public instance Vue handed the error handler
 * @returns {string} A name to put in the line
 */
function componentName(instance) {
  return instance?.$options?.name ?? instance?.$?.type?.__name ?? 'anonymous'
}

/**
 * The app's global error sink: everything that escapes a component, a promise or the page itself
 * reaches the console as one `[cardinal:app]` line, with the error object passed through so the
 * browser draws its own expandable stack.
 *
 * **Nothing here talks to the server.** The decision (triage 2026-09-06) is console only — a
 * reporting endpoint would need a retention story, a rate limit and a consent position, none of
 * which exist. This file is the one place to hook one if that changes; do not add a second sink
 * somewhere else.
 *
 * **Neither window listener calls `preventDefault()`.** The browser's own uncaught-error entry is
 * meant to stay: it carries the source location and the live stack, which a logged line does not
 * replace. What this adds beside it is the uniform, greppable prefix every other line in the app
 * already has.
 *
 * `warnHandler` is set in development only. Vue's warnings are compiled out of a production build,
 * so a handler there would sit on a path that never fires, and routing them through the helper in
 * dev is what keeps a framework warning looking like the rest of the app's output.
 *
 * @param {object} app The Vue application instance
 * @returns {Function} Removes the two window listeners again — for tests, which install the
 *   handlers once per case; `main.js` boots once and ignores it
 */
export function initializeErrors(app) {
  app.config.errorHandler = (err, instance, info) => {
    log.error('app', `uncaught in ${componentName(instance)} during ${info}`, err)
  }

  if (import.meta.env.DEV) {
    app.config.warnHandler = (msg) => {
      // -> Vue writes its own wording here; it is passed through as-is rather than reworded into
      //    the helper's lowercase-fragment house style, so a warning stays searchable against
      //    Vue's own docs and source
      log.warn('app', msg)
    }
  }

  const onRejection = (ev) => {
    log.error('app', 'unhandled promise rejection', ev.reason)
  }
  const onError = (ev) => {
    log.error('app', ev.message, ev.error)
  }

  window.addEventListener('unhandledrejection', onRejection)
  window.addEventListener('error', onError)

  return () => {
    window.removeEventListener('unhandledrejection', onRejection)
    window.removeEventListener('error', onError)
  }
}
