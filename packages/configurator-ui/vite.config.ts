// Vite+ per-package settings. The `test` task definition is shared by every package whose tests run
// under vitest and ships as `@gadgets/scripts/vitest-task`.
import vitestTaskViteConfig from '@gadgets/scripts/vitest-task'

export default vitestTaskViteConfig('vitest run --passWithNoTests')
