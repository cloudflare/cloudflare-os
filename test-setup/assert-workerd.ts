// Fails the suite unless it is genuinely executing inside workerd.
//
// Every package that lists this in `setupFiles` runs its tests through @cloudflare/vitest-pool-workers
// so they exercise the production runtime. When that pool cannot start, vitest falls back to running
// the files under Node -- and only the suites that import `cloudflare:test` or `cloudflare:workers`
// notice. `router` and `typed-storage` import neither, so they would stay green while silently
// testing the wrong runtime.
//
// `navigator.userAgent` is the cheapest unambiguous probe: workerd hardcodes it, Node does not define
// `navigator.userAgent` as this value.
if (navigator.userAgent !== "Cloudflare-Workers") {
  throw new Error(
    `Expected to be running inside workerd, but navigator.userAgent is ${JSON.stringify(
      navigator.userAgent,
    )}. The vitest-pool-workers pool did not start -- fix that rather than deleting this check.`,
  );
}
