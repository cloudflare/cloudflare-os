import vitestTaskViteConfig, { withTestTimeout } from '../../scripts/vitest-task-vite-config.js'

const config = vitestTaskViteConfig('vitest run')

export default {
  run: {
    tasks: {
      /** Builds the fixture and orders both validated Workers before test files start. */
      'build:test-gatekeeper': {
        command: withTestTimeout(
          'capnweb-validate build --cwd fixtures/gatekeeper-test --out .wrangler/validate',
        ),
        cache: false,
        dependsOn: ['@gadgets/workshop-backend#build:integration-worker'],
      },
      test: {
        command: config.run.tasks.test.command,
        // Backend source reaches this task through the gitignored validated entrypoint.
        // Running the fast suite is safer than maintaining a second source fingerprint.
        cache: false,
        dependsOn: ['build:test-gatekeeper'],
      },
    },
  },
}
