// Stand-in for `capnweb-validate` under plain vitest. The real decorators throw when the
// capnweb-validate build transform hasn't run (it only runs in the wrangler build), so tests that
// construct an `@validateRpc()` class directly get no-ops instead. Runtime argument validation is
// a production-bundle concern; these tests exercise the methods' own logic.

export const validateRpc = () => (_target: unknown, _ctx?: unknown): void => {};

export const skipRpcValidation = () => (_target: unknown, _ctx?: unknown): void => {};
