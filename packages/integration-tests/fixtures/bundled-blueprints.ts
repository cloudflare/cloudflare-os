// Stands in for workshop-backend's generated `bundled-blueprints.ts` in a Workshop built with
// `bundleBlueprints()` (src/harness.ts), so that the blueprints the deployment ships with are the
// ones a test names rather than the ones this repo ships. That is how a test deploys a build
// whose bundled blueprints differ from the last one's.
//
// The list arrives as a build-time `define`, already in the generated module's shape.

declare const TEST_BUNDLED_BLUEPRINTS: unknown[];

export const BUNDLED_BLUEPRINTS = TEST_BUNDLED_BLUEPRINTS;
