import { createApp } from 'vue'
import { initializeRouter } from './router'
import { initializeStore } from './stores'
import { initializeApi } from './boot/api'
import { initializeComponents } from './boot/components'
import { initializeErrors } from './boot/errors'
import { initializeEventBus } from './boot/eventbus'
import { initializeExternals } from './boot/externals'
import { initializeI18n } from './boot/i18n'
import { initializeIconify } from './boot/iconify'
import './boot/monaco'
import { initializeServiceWorker } from './boot/serviceWorker'
import { initializeTemporal } from './boot/temporal'
import { initializeHairlines } from './helpers/hairline'

import './css/tailwind.css'
import './css/app.css'

import RootApp from './App.vue'

// Must come first: everything below may use Temporal, directly or indirectly.
await initializeTemporal()

const router = initializeRouter()
const store = initializeStore(router)

const app = createApp(RootApp)
app.use(store)
app.use(router)

initializeHairlines()
initializeApi(router)
initializeComponents(app)
initializeEventBus()
initializeErrors(app)
initializeIconify()
initializeExternals(router)
initializeI18n(app, store)
app.mount('#app')
initializeServiceWorker()
