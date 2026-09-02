import mitt from 'mitt'

export function initializeEventBus() {
  window.EVENT_BUS = mitt()
}
