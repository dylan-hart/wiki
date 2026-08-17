import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

/**
 * Vitest gets its own minimal config rather than sharing `vite.config.js`: that file's plugins exist
 * for the app build (Tailwind, the twemoji asset copy, devtools) and read `config.yml` at import time
 * for the dev proxy target -- none of which a unit test needs or wants running. Only the `@` alias is
 * shared, since helpers under test import through it the same way the app does.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  test: {
    environment: 'node',
    setupFiles: [fileURLToPath(new URL('./test/setup.js', import.meta.url))],
    include: ['src/**/*.test.js']
  }
})
