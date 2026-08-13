import { defineConfig } from 'vitest/config'
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'

/**
 * Tests run inside workerd (via vitest-pool-workers) so they exercise the same runtime APIs as
 * production. A minimal inline Miniflare config suffices: the tests call the exported handler
 * directly with stub env objects, so no real service bindings are needed.
 */
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: '2026-02-02',
        compatibilityFlags: ['nodejs_compat'],
      },
    }),
  ],
  test: {
    include: ['__tests__/*.test.ts'],
    // Nothing here imports `cloudflare:test`, so a pool that failed to start would leave this suite
    // green while running under Node. The guard makes that fail loudly instead.
    setupFiles: ['../../test-setup/assert-workerd.ts'],
  },
})
