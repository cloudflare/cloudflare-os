import { defineConfig } from 'vite-plus'
import { vitestTask } from '../../scripts/vitest-task-vite-config.js'

/**
 * Vite+ settings for this package. The SPA's own build config lives in `vite.app.config.ts`;
 * Vite+ reads per-package settings only from `vite.config.*`, so the two cannot share a file.
 */
export default defineConfig({
  run: {
    tasks: {
      // Shared by every package whose tests run under vitest; see the module for why the two
      // vitest scratch paths have to be excluded for this to cache at all.
      test: vitestTask('vitest run'),
      // Uncached: a cache hit restores archived outputs but never deletes files, so the sourcemap
      // artifacts of an enabled-reporting build (dist-app/gatekeeper-context.js + .js.map) would
      // survive a later disabled-reporting cache hit and could be collected as if they matched the
      // current bundle. This runs every time, before the cache lookup.
      'clean:error-reporting-artifacts': {
        command: 'node ../../scripts/clean-error-reporting-artifacts.ts .',
        cache: false,
      },
      // A task rather than a package.json script so `input` can be stated explicitly: automatic
      // tracking treats the whole package as input, and this build writes `dist-app/` and
      // `src/generated/app.txt` back into it, so nothing ever cached.
      //
      // The exclusions have to be workspace-wide, not package-relative -- tracking reaches past the
      // package, so a sibling gatekeeper's `dist-app/` would otherwise stay in the fingerprint and
      // the gatekeepers would invalidate each other. Only directory *contents* can be excluded, not
      // the directories, so a deleted output tree still costs one cold build.
      'build:app': {
        command: 'node build-app.mjs',
        dependsOn: ['clean:error-reporting-artifacts'],
        input: [
          { auto: true },
          { pattern: '!**/dist-app/**', base: 'workspace' },
          { pattern: '!**/src/generated/**', base: 'workspace' },
          // Wrangler's scratch bundles are randomly named, so without this a `pnpm dev-server` run
          // guarantees a miss on the next one.
          { pattern: '!**/.wrangler/**', base: 'workspace' },
        ],
        output: ['dist-app/**', 'src/generated/app.txt'],
        // Read via `loadEnv` in vite.app.config.ts and baked into the bundle, so it belongs in the
        // fingerprint.
        env: ['VITE_FRONTEND_ERROR_REPORTING'],
      },
      // The same build unminified, run by the `pnpm dev-server` pre-flight. The app watcher cannot
      // skip its own initial build, so the pre-flight's output is rebuilt regardless; matching the
      // watcher's bytes lets `emitAppText` skip the write that would otherwise restart the worker
      // mid-startup. `build` and `deploy` still use `build:app`, so nothing unminified ships.
      //
      // Captures only `app.txt`: `dist-app/` has no reader outside vite.app.config.ts and the watcher
      // rebuilds it moments later (`emptyOutDir`), so restoring it would be megabytes of writes on
      // the startup critical path.
      'build:app:dev': {
        command: 'node build-app.mjs --dev',
        dependsOn: ['clean:error-reporting-artifacts'],
        input: [
          { auto: true },
          { pattern: '!**/dist-app/**', base: 'workspace' },
          { pattern: '!**/src/generated/**', base: 'workspace' },
          { pattern: '!**/.wrangler/**', base: 'workspace' },
        ],
        output: ['src/generated/app.txt'],
        env: ['VITE_FRONTEND_ERROR_REPORTING'],
      },
    },
  },
})
