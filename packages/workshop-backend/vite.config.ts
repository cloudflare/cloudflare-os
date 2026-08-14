// Vite+ per-package settings. The `test` task definition is shared by every package whose tests run
// under vitest and lives beside the other shared task configs.
import vitestTaskViteConfig from '../../scripts/vitest-task-vite-config.js'

/**
 * The two codegen steps stay separate commands rather than one `&&` string so each is cached on its
 * own: a run that touched neither the browser runtime nor the format blueprints replays both and
 * re-runs only the vitest passes.
 */
export default vitestTaskViteConfig([
  'node build-browser-runtime.mjs',
  'node scripts/build-format-blueprints.mjs',
  'vitest run',
  'vitest run --config vitest.integration.config.ts',
])
