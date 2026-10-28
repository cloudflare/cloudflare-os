import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import tsconfigPaths from 'vite-tsconfig-paths'
import { TanStackRouterVite } from '@tanstack/router-plugin/vite'
import { vitestTask } from '@gadgets/scripts/vitest-task'

const ownDist = { pattern: '!dist/**', base: 'package' } as const
const viteBuildCommand =
  `node --input-type=module -e "process.env.NODE_ENV='production'; await (await import('vite')).build()"`

const runConfig = {
  run: {
    tasks: {
      'clean:dist': {
        command: `node --input-type=module -e "import { rmSync } from 'node:fs'; rmSync('dist', { recursive: true, force: true })"`,
        cache: false,
      },
      // A task rather than a script so `cache.env` can declare the `VITE_*` values the bundle
      // inlines. `dist/` is excluded from the inputs because vp declines to cache a task that reads
      // a path it also wrote.
      build: {
        command: ['tsc', 'tsc -p tsconfig.vite.json', viteBuildCommand],
        dependsOn: ['clean:dist'],
        cache: {
          env: ['VITE_*'],
          input: [
            { auto: true },
            ownDist,
            { pattern: '!**/.wrangler/**', base: 'workspace' } as const,
          ],
          output: ['dist/**'],
        },
      },
      // Shared with the other packages: keeps vitest's scratch files out of the cache fingerprint.
      test: vitestTask(['vitest run'], [ownDist]),
    },
  },
}

export default defineConfig(({ mode }) => {
  const backendHost = loadEnv(mode, process.cwd()).VITE_BACKEND_HOST?.trim() || 'localhost:8787'
  return {
    // Spread rather than a literal: `run` is Vite+'s field, absent from vite's own `defineConfig`.
    ...runConfig,
    plugins: [
      TanStackRouterVite({ target: 'react', autoCodeSplitting: true }),
      react(),
      tailwindcss(),
      tsconfigPaths(),
    ],
    server: {
      // The existing Workshop frontend owns :3000; this app runs beside it.
      port: 3001,
      host: true,
      // The app talks to its own origin, as in production, where the router fronts the backend.
      // `ws` carries the RPC WebSocket.
      proxy: { '/api': { target: `http://${backendHost}`, ws: true } },
    },
  }
})
