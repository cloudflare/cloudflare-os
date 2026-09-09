/// <reference types="@cloudflare/vitest-pool-workers/types" />

// Pulls in the `cloudflare:test` module types for the workerd suite. The test-only bindings from
// `vitest.worker.config.ts` are narrowed at their use site instead of being merged into
// `Cloudflare.Env`: the Node suite builds `Env` literals by hand, and a global augmentation would
// oblige every one of them to carry bindings that only exist under the pool.
