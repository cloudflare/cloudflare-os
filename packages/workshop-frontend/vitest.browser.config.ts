import { defineConfig } from 'vitest/config'
import { playwright } from '@vitest/browser-playwright'
import react from '@vitejs/plugin-react'
import tsconfigPaths from 'vite-tsconfig-paths'

/**
 * The browser suite, `src/**\/*.browser.test.tsx`: what only a real browser shows -- pointer and
 * keyboard input, focus -- in headless Chromium, which `playwright install chromium` fetches. The
 * rest of the tests run under `vite.config.ts`, which leaves these out.
 */
export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  test: {
    include: ['src/**/*.browser.test.tsx'],
    // Kept with vitest's other scratch, under node_modules/.vite, out of the source tree and the
    // test task's fingerprint: a failure's screenshot, and the copy of it attached to the report.
    attachmentsDir: 'node_modules/.vite/vitest-browser/attachments',
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [{ browser: 'chromium' }],
      screenshotDirectory: 'node_modules/.vite/vitest-browser/screenshots',
    },
  },
})
