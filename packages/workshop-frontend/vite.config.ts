import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import tsconfigPaths from 'vite-tsconfig-paths'
import { TanStackRouterVite } from '@tanstack/router-plugin/vite'
import vitestTaskViteConfig from '../../scripts/vitest-task-vite-config.js'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd())
  const backendHost = env.VITE_BACKEND_HOST?.trim() || 'localhost:8787'
  const frontendErrorReporting = env.VITE_FRONTEND_ERROR_REPORTING === 'true'
  return {
    // Spread, not a literal `run: {...}`: `run` is Vite+'s field and vite's own `defineConfig` has
    // no such property, but the excess-property check doesn't reach spreads.
    ...vitestTaskViteConfig('vitest run', [
      // `vite build` writes the SPA bundle here and CI builds before it tests, so tracking `dist/`
      // meant never caching. Keep it package-relative: `typed-storage` emits, and its `exports`
      // resolves to `dist/index.js`, so a workspace-wide `!**/dist/**` would drop a real input.
      { pattern: '!dist/**', base: 'package' },
    ]),
    resolve: {
      // Remove when y-monaco supports Monaco 0.56: https://github.com/yjs/y-monaco/pull/31
      alias: {
        'monaco-editor/esm/vs/editor/editor.api.js': 'monaco-editor/editor',
      },
    },
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
