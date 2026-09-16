import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import tsconfigPaths from 'vite-tsconfig-paths'
import { viteSingleFile } from 'vite-plugin-singlefile'

const pkgDir = dirname(fileURLToPath(import.meta.url))

// `--watch` drives the `pnpm dev-server` hot loop (via build-app.mjs); one-shot build otherwise.
const isWatch = process.argv.includes('--watch')

// Minification is the only thing that differs between the watch build and the one-shot build, so
// it is the only reason their `src/generated/app.txt` bytes differ -- and that difference is what
// makes `pnpm dev-server` rebuild the app twice and restart Wrangler mid-startup: the cached
// one-shot build lands first, then the watcher's initial build overwrites it. `build:app:dev` sets
// this so the pre-flight produces exactly what the watcher will, letting the write be skipped.
const unminified = isWatch || process.env.GATEKEEPER_APP_UNMINIFIED === 'true'

// Write the inlined build to src/generated/app.txt for the Worker to import. Skip identical
// rewrites, which would otherwise loop wrangler's watcher.
function emitAppText(frontendErrorReporting: boolean): Plugin {
  return {
    name: 'emit-app-text',
    closeBundle() {
      const html = readFileSync(resolve(pkgDir, 'dist-app', 'app', 'index.html'), 'utf8')
        .replace(
          /(<script type="module"[^>]*>)([\s\S]*?)(<\/script>)/,
          '$1$2\n//# sourceURL=app:///gatekeeper/context/gatekeeper-context.js\n$3',
        )
      const script = html.match(/<script type="module"[^>]*>([\s\S]*?)<\/script>/)?.[1]
      if (script && frontendErrorReporting) {
        writeFileSync(
          resolve(pkgDir, 'dist-app', 'gatekeeper-context.js'),
          `${script}\n//# sourceMappingURL=gatekeeper-context.js.map\n`,
        )
      }
      const outFile = resolve(pkgDir, 'src', 'generated', 'app.txt')
      const contents =
        `<!-- Generated from packages/gatekeeper-context/app by build-app.mjs. Do not edit. -->\n` + html
      if (existsSync(outFile) && readFileSync(outFile, 'utf8') === contents) {
        console.log(`app.txt unchanged (${(html.length / 1024).toFixed(0)} KiB), skipping write`)
        return
      }
      mkdirSync(dirname(outFile), { recursive: true })
      writeFileSync(outFile, contents)
      console.log(`wrote ${outFile} (${(html.length / 1024).toFixed(0)} KiB)`)
    },
  }
}

/** Build the library iframe as one inlined HTML file. No router; selection is component state. */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, pkgDir)
  const frontendErrorReporting = env.VITE_FRONTEND_ERROR_REPORTING === 'true'
  return {
    plugins: [
      react(),
      tailwindcss(),
      tsconfigPaths(),
      viteSingleFile(),
      emitAppText(frontendErrorReporting),
    ],
    build: {
      outDir: 'dist-app',
      emptyOutDir: true,
      // Terser costs ~3s/build; skip it in the dev hot loop where only latency matters.
      minify: unminified ? false : 'terser',
      terserOptions: {
        compress: {
          passes: 2,
        },
        format: {
          comments: false,
        },
      },
      // Network-isolated iframe: no separate asset files.
      assetsInlineLimit: 100_000_000,
      cssCodeSplit: false,
      sourcemap: frontendErrorReporting ? 'hidden' : false,
      rollupOptions: {
        input: 'app/index.html',
        output: {
          entryFileNames: 'gatekeeper-context.js',
        },
      },
      // Exclude our own outputs, else emitting them retriggers the watcher.
      watch: isWatch
        ? {
            exclude: [
              '**/node_modules/**',
              '**/dist-app/**',
              '**/.wrangler/**',
              '**/generated/**',
            ],
          }
        : undefined,
    },
  }
})
