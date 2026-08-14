// Vite+ per-package settings. The `test` task definition is shared by every package whose tests run
// under vitest and lives beside the other shared task configs.
import vitestTaskViteConfig from '../../scripts/vitest-task-vite-config.js'

export default vitestTaskViteConfig('vitest run')
