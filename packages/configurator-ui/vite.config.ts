// Vite+ per-package settings, and the Node suite: the runtime's pure logic and the build. Component
// behaviour and the generated frame run in Chromium under `vitest.browser.config.ts`.
import { configDefaults } from 'vitest/config'
import { vitestTask } from '@gadgets/scripts/vitest-task'
import { preactViteAliases } from './build/aliases.ts'

export default {
  run: {
    tasks: {
      test: vitestTask(['vitest run', 'vitest run -c vitest.browser.config.ts']),
    },
  },
  resolve: { alias: preactViteAliases() },
  define: { __FRONTEND_REPORTING__: 'false' },
  test: {
    exclude: [...configDefaults.exclude, '**/*.browser.test.{ts,tsx}'],
  },
}
