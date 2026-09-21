import { log } from '../helpers/log'

export const SERVICE_WORKER_URL = '/sw.js'

async function register() {
  try {
    await navigator.serviceWorker.register(SERVICE_WORKER_URL)
  } catch (err) {
    log.warn('app', 'could not register the service worker', err)
  }
}

export function initializeServiceWorker() {
  if (import.meta.env.DEV || !('serviceWorker' in navigator)) {
    return
  }
  if (document.readyState === 'complete') {
    register()
  } else {
    window.addEventListener('load', register, { once: true })
  }
}
