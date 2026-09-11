import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { Plugin } from 'vite'
import { defineConfig } from 'vitest/config'
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import capnwebValidate from 'capnweb-validate/vite'

// Wrangler ships `*.txt` imports as Text modules (its default module rules; see
// src/text-modules.d.ts), but this config drives the pool from inline miniflare settings, and
// vite's own fallback would resolve them as asset URLs. Mirror the Text-module behavior so code
// under test (e.g. describeBinding's worktree-binding.txt) sees the real content. Like wrangler,
// match on the *import path*: resolving here keeps vite from realpathing the id, which for a
// symlinked .txt (the binding .txts are symlinks to their .d.ts) would dodge the load hook
// below and fall through to the TypeScript pipeline.
const textModules: Plugin = {
  name: 'text-modules',
  enforce: 'pre',
  resolveId(source, importer) {
    if (source.endsWith('.txt') && importer !== undefined) {
      return path.resolve(path.dirname(importer), source)
    }
  },
  load(id) {
    if (id.endsWith('.txt')) {
      return `export default ${JSON.stringify(readFileSync(id, 'utf-8'))};`
    }
  },
}

/**
 * Tests run inside workerd (via vitest-pool-workers) so they exercise the same runtime APIs as
 * production -- e.g. Uint8Array.toHex/fromHex and crypto.subtle used by the sharing module. Most
 * tests import modules directly; the main Worker and a test-only SQLite DO binding support the
 * Overseer cost-persistence integration test without loading the full deployment configuration.
 */
export default defineConfig({
  plugins: [
    textModules,
    capnwebValidate(),
    cloudflareTest({
      // The production Worker plus test-only entrypoints (see __tests__/test-worker.ts).
      main: './__tests__/test-worker.ts',
      miniflare: {
        compatibilityDate: '2026-09-04',
        // `allow_irrevocable_stub_storage` as in wrangler.jsonc: the user DO persists account stubs.
        compatibilityFlags: ['experimental', 'nodejs_compat', 'allow_irrevocable_stub_storage'],
        bindings: { PUBLIC_BASE_URL: 'https://workshop.example/' },
        durableObjects: {
          TEST_OVERSEER: { className: 'OverseerDurableObject', useSQLite: true },
          TEST_USER: { className: 'UserDurableObject', useSQLite: true },
          TEST_PENDING_LOGIN: { className: 'PendingLogin', useSQLite: true },
          TEST_USER_DIRECTORY: { className: 'UserDirectoryDurableObject', useSQLite: true },
        },
      },
    }),
  ],
  test: {
    include: ['__tests__/*.test.ts'],
    // Asserts the pool actually started, rather than trusting a green run to mean workerd.
    setupFiles: ['@gadgets/scripts/assert-workerd'],
  },
})
