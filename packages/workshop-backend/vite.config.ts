import { defineConfig } from 'vite-plus'
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import capnwebValidate from 'capnweb-validate/vite'

const EXPECTED_OPEN_ERROR_CODES = new Set([
  'WORKSPACE_NOT_FOUND',
  'WORKSPACE_ACCESS_DENIED',
])

// Both suites run inside workerd (via vitest-pool-workers) so they exercise the same runtime APIs
// as production -- e.g. Uint8Array.toHex/fromHex and crypto.subtle used by the sharing module.
// They are separate projects because they load the Worker differently: the unit suite declares a
// minimal inline Miniflare config, while the integration suite boots the real deployment config
// from wrangler.jsonc. `vp test run` runs both; `--project integration` runs one.
export default defineConfig({
  test: {
    projects: [
      {
        plugins: [
          capnwebValidate(),
          cloudflareTest({
            main: './src/server.ts',
            miniflare: {
              compatibilityDate: '2026-02-02',
              compatibilityFlags: ['experimental', 'nodejs_compat'],
              durableObjects: {
                TEST_OVERSEER: { className: 'OverseerDurableObject', useSQLite: true },
              },
            },
          }),
        ],
        // Most tests import modules directly; the main Worker and a test-only SQLite DO binding
        // support the Overseer cost-persistence integration test without loading the full
        // deployment configuration.
        test: {
          name: 'unit',
          include: ['__tests__/*.test.ts'],
        },
      },
      {
        esbuild: {
          target: 'es2022',
        },
        plugins: [
          capnwebValidate(),
          cloudflareTest({
            main: './src/server.ts',
            remoteBindings: false,
            wrangler: {
              configPath: './wrangler.jsonc',
            },
          }),
        ],
        test: {
          name: 'integration',
          include: ['__integration__/*.test.ts'],
          // Whichever test runs first pays for workerd booting and instantiating the whole backend
          // bundle -- ~6s on a dev machine and roughly 3x that on a CI runner, while every subsequent
          // test in the file finishes in tens of milliseconds. The timeout has to clear that cold
          // start, not the steady-state cost, or the first test fails wherever the runner is slow.
          testTimeout: 60_000,
          // A rejected future capability is reported independently from the awaited pipelined call.
          // The tests assert these exact rejections; all unrelated unhandled errors remain fatal.
          onUnhandledError(error) {
            const code = 'code' in error ? error.code : undefined
            if (typeof code === 'string' && EXPECTED_OPEN_ERROR_CODES.has(code)) return false
          },
        },
      },
    ],
  },
})
