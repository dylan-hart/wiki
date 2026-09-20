import { log } from '@/helpers/log'

/**
 * `__name` is the filename-derived name the SFC compiler stamps onto a `<script setup>` component,
 * which is every component here that has not declared one. Neither exists for an inline object
 * component, a render function, or an error that fired with no component instance attached.
 */
function componentName(instance) {
  return instance?.$options?.name ?? instance?.$?.type?.__name ?? 'anonymous'
}

/**
 * The app's one error sink, and console-only by decision: a reporting endpoint would need a
 * retention story, a rate limit and a consent position, none of which exist. Hook one in here if
 * that changes rather than adding a second sink somewhere else.
 *
 * **Neither window listener calls `preventDefault()`.** The browser's own uncaught-error entry is
 * meant to stay: it carries the source location and the live stack, which a logged line does not
 * replace.
 *
 * `warnHandler` is set in development only — Vue's warnings are compiled out of a production build,
 * so a handler there would sit on a path that never fires.
 *
 * @returns {Function} Removes the two window listeners again — for tests, which install the
 *   handlers once per case; `main.js` boots once and ignores it
 */
export function initializeErrors(app) {
  app.config.errorHandler = (err, instance, info) => {
    log.error('app', `uncaught in ${componentName(instance)} during ${info}`, err)
  }

  if (import.meta.env.DEV) {
    app.config.warnHandler = (msg) => {
      // -> Passed through as Vue worded it rather than reworded into the helper's
      //    lowercase-fragment house style, so a warning stays searchable against Vue's own source
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
