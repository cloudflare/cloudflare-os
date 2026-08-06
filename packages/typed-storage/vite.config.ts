import { defineConfig } from 'vite-plus'
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'

// Tests run inside workerd (via vitest-pool-workers) so they exercise the same runtime as
// production. A minimal inline Miniflare config is used since the tests mock DurableObjectStorage
// and don't need any real bindings.
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
  },
})
