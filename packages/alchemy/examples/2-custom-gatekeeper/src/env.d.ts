// Types `ctx.exports` for same-module loopback (accounts, verifiers, and
// the resource DO are minted as capabilities from this module's own
// exports). Must stay a global script — no top-level import/export — for
// the declaration merges to apply. Same shape as
// packages/integration-tests/fixtures/gatekeeper-test/src/env.d.ts.

declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./worker.js");
    durableNamespaces: "AcmeThing";
  }
}

interface ExecutionContext<Props = unknown> {
  readonly exports: Cloudflare.Exports;
}

interface DurableObjectState<Props = unknown> {
  readonly exports: Cloudflare.Exports;
}
