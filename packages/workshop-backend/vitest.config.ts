import { defineConfig } from 'vitest/config'
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import capnwebValidate from 'capnweb-validate/vite'

const EXPECTED_RPC_REJECTIONS = new Set([
  'Collaborators requires an explicitly invited, verified @totango.com SSO collaborator.',
  'Finance workspaces are invite-only and do not support share links.',
  'Internal share links only support Gadget-only access.',
])

/**
 * Tests run inside workerd (via vitest-pool-workers) so they exercise the same runtime APIs as
 * production -- e.g. Uint8Array.toHex/fromHex and crypto.subtle used by the sharing module. Most
 * tests import modules directly; the main Worker and a test-only SQLite DO binding support the
 * Overseer cost-persistence integration test without loading the full deployment configuration.
 */
export default defineConfig({
  plugins: [
    capnwebValidate(),
    cloudflareTest({
      main: './src/server.ts',
      miniflare: {
        compatibilityDate: '2026-02-02',
        compatibilityFlags: ['experimental', 'nodejs_compat'],
        bindings: {
          TEAM_PI_CODEX_BASE_URL: 'https://team-pi.example/proxy',
          TEAM_PI_CODEX_HMAC_SECRET: 'team-pi-secret',
          TEAM_PI_CODEX_MODELS:
            'gpt-6-astra,gpt-5.6-sol,gpt-5.6-terra,gpt-5.6-luna,gpt-5.5,gpt-5.4,gpt-5.4-mini',
          TEAM_PI_CODEX_ONLY: 'true',
        },
        kvNamespaces: ['BLUEPRINTS'],
        durableObjects: {
          TEST_OVERSEER: { className: 'OverseerDurableObject', useSQLite: true },
          TEST_USER: { className: 'UserDurableObject', useSQLite: true },
          TEST_ADMIN: { className: 'AdminSettings', useSQLite: true },
        },
      },
    }),
  ],
  test: {
    include: ['__tests__/*.test.ts'],
    // Asserts the pool actually started, rather than trusting a green run to mean workerd.
    setupFiles: ['../../scripts/assert-workerd.ts'],
    // Cap'n Web reports a rejected future capability independently from the awaited RPC promise.
    // The policy tests assert these exact denials; unrelated unhandled errors remain fatal.
    onUnhandledError(error) {
      if (EXPECTED_RPC_REJECTIONS.has(error.message)) return false
    },
  },
})
