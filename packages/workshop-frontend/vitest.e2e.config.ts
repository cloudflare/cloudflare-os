import { defineConfig } from 'vitest/config'

/**
 * The end-to-end suite, `e2e/**\/*.e2e.ts`: core Workshop flows in headless Chromium, driven by
 * Playwright against a running Workshop at `E2E_BASE_URL` (a PR preview, or `pnpm dev-server` plus
 * `pnpm dev-client` locally). Its own config, outside the package's `test` task: it needs a
 * running Workshop. scripts/automerge/evidence/preview-e2e.ts runs it and judges the report.
 */
export default defineConfig({
  test: {
    include: ['e2e/**/*.e2e.ts'],
    environment: 'node',
    // One Workshop serves every flow; running files at once would only race its accounts.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
