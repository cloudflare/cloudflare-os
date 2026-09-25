// `wrangler types` does not currently emit declarations for Node module specifiers when only the
// focused `nodejs_als` flag is enabled. Declare the small supported surface used by this package
// without pulling the full Node.js type environment into every consuming Worker.
declare module "node:async_hooks" {
  export class AsyncLocalStorage<Store> {
    getStore(): Store | undefined;
    run<Result>(store: Store, callback: () => Result): Result;
  }
}
