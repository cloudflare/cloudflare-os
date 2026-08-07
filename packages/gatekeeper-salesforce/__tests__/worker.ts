// Test-harness worker exposing the Salesforce gatekeeper source under the vitest-pool-workers
// runtime, with the SF_DB D1 binding available.

export { default } from "../src/index.js";
export * from "../src/index.js";

// Re-export the D1 store so integration tests can exercise it against a real local D1 database.
export * from "../src/sf-store.js";
