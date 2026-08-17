import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath } from 'node:url'

/**
 * A dedicated, minimal Vite config for Vitest -- deliberately NOT `vite.config.js`. That file wires
 * up the Tailwind and twemoji-assets plugins (the latter throws unless `twemoji-assets` is resolvable
 * and does a real filesystem copy in `writeBundle`) and reads `../config.yml` for the dev proxy port,
 * none of which a component unit test needs or wants paying the cost of on every run. Component
 * tests only need the SFC compiler and the `@` alias the app's source uses everywhere.
 */
export default defineConfig({
  plugins: [
    vue({
      template: {
        compilerOptions: {
          isCustomElement: (tag) => tag === 'iconify-icon'
        }
      }
    })
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.test.js']
  }
})
