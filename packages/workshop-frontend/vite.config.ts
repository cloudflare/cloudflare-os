import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import tsconfigPaths from 'vite-tsconfig-paths'
import { TanStackRouterVite } from '@tanstack/router-plugin/vite'
import { vitestTask } from '../../scripts/vitest-task-vite-config.js'

// `dist/` is this package's own build output, excluded from the inputs of both tasks: vp declines to
// cache a task that reads a path it also wrote. Package-relative rather than workspace-wide --
// `typed-storage` emits, and its `exports` resolves to `dist/index.js`, so a pattern matching every
// package's `dist` would drop a real input.
const ownDist = { pattern: '!dist/**', base: 'package' } as const

const runConfig = {
  run: {
    tasks: {
      'clean:dist': { command: 'rm -rf dist', cache: false },
      /**
       * `build` is a task rather than a package.json script so `env` can declare the `VITE_*` flags
       * it reads: a cached `vp` run executes scripts in a clean environment, and the values would be
       * missing from the fingerprint besides. `VITE_CF_ACCESS_MODE` is inlined into the bundle
       * (`src/useAuth.ts`) and `VITE_FRONTEND_ERROR_REPORTING` selects hidden source maps below, so
       * replaying a bundle built under different values is wrong rather than merely stale.
       *
       * Separate commands rather than one `&&` string so each is a cache entry of its own; `env` is
       * task-wide, so changing a flag re-runs all three anyway. `tsconfig.vite.json` is the
       * config-file pass (`vite.config.ts` and the scripts it imports), which the app's own
       * `tsconfig.json` excludes.
       *
       * `NODE_ENV=production` applies to this command alone and changes nothing in the normal case:
       * vite already defaults a build to production when `NODE_ENV` is unset. It is here because
       * vite takes `isProduction` from `NODE_ENV` and not from `--mode`, so an ambient
       * `NODE_ENV=development` would otherwise ship a development bundle from `--no-cache`, the
       * path `deploy` uses.
       */
      build: {
        command: ['tsc', 'tsc -p tsconfig.vite.json', 'NODE_ENV=production vite build'],
        dependsOn: ['clean:dist'],
        env: ['VITE_*'],
        input: [
          { auto: true },
          ownDist,
          // Wrangler's scratch bundles are randomly named, and tracking reaches past the package
          // that owns the task, so any sibling that ran `wrangler dev` guarantees a miss here on the
          // next run -- vp reported one as `'bundle-1434329262.js' added in
          // 'packages/workshop-backend/.wrangler/tmp'`. Workspace-wide for that reason; `build:app`
          // and the shared `test` task exclude the same tree.
          { pattern: '!**/.wrangler/**', base: 'workspace' } as const,
        ],
        output: ['dist/**'],
      },
      test: vitestTask('vitest run', [ownDist]),
    },
  },
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd())
  const backendHost = env.VITE_BACKEND_HOST?.trim() || 'localhost:8787'
  const frontendErrorReporting = env.VITE_FRONTEND_ERROR_REPORTING === 'true'
  return {
    // Spread, not a literal `run: {...}`: `run` is Vite+'s field and vite's own `defineConfig` has
    // no such property, but the excess-property check doesn't reach spreads.
    ...runConfig,
    plugins: [
      TanStackRouterVite({ target: 'react', autoCodeSplitting: true }),
      react(),
      tailwindcss(),
      tsconfigPaths(),
    ],
    server: {
      port: 3000,
      host: true,
      proxy: {
        '/api/client-errors': `http://${backendHost}`,
        '/blueprint-screenshot': `http://${backendHost}`,
        '/api/site-logo': `http://${backendHost}`,
      },
    },
    build: {
      // Production reporting uploads these separately; hidden maps never reveal a map URL to users.
      sourcemap: frontendErrorReporting ? 'hidden' : false,
    },
  }
})
