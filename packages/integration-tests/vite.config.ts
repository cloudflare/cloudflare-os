import vitestTaskViteConfig from '../../scripts/vitest-task-vite-config.js'

const config = vitestTaskViteConfig('vitest run')

export default {
  run: {
    tasks: {
      test: {
        command: config.run.tasks.test.command,
        // Backend source reaches this task through the gitignored validated entrypoint.
        // Running the fast suite is safer than maintaining a second source fingerprint.
        cache: false,
        dependsOn: ['@gadgets/workshop-backend#build:integration-worker'],
      },
    },
  },
}
