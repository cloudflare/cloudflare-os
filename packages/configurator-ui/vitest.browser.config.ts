import { defineConfig } from 'vitest/config'
import { playwright } from '@vitest/browser-playwright'
import { preactViteAliases } from './build/aliases.ts'

/**
 * The browser suite, `src/**\/*.browser.test.tsx`, in headless Chromium (`playwright install
 * chromium` fetches it): the runtime's components under real pointer and keyboard input. Kumo and
 * Base UI support only React, and this suite is what catches an upgrade that stops working on
 * `preact/compat`. The generated frame itself is driven from Node (`build/*.test.ts`).
 */
export default defineConfig({
  resolve: { alias: preactViteAliases() },
  define: { __FRONTEND_REPORTING__: 'false' },
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
