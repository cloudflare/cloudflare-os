// Project-specific ctx.exports typing, the same shape gatekeeper-context/src/env.d.ts uses --
// except that the shipping gatekeepers get the `exports` member on ExecutionContext and
// DurableObjectState from their generated worker-configuration.d.ts, which this fixture deliberately
// does not carry (see the note in wrangler.jsonc). @cloudflare/workers-types declares the
// Cloudflare.GlobalProps -> Cloudflare.Exports machinery but not the member itself, so declare it
// here. This file must stay a global script (no top-level import/export) for the merges to apply.

declare namespace Cloudflare {
  interface GlobalProps {
    // Populates Cloudflare.Exports, the type of ctx.exports.
    mainModule: typeof import("./test-gatekeeper.js");
    // Storage classes exposed as DO namespaces on ctx.exports.
    durableNamespaces: "TestGatekeeper" | "TestControl";
  }

  interface Env {
    // The Workshop's external-message gateway entrypoint (see wrangler.jsonc). The contract
    // interface is not entrypoint-branded (the shipping class implements it), so brand it here to
    // satisfy Fetcher's constraint.
    WORKSHOP_EXTERNAL_MESSAGES: Fetcher<
        import("@gadgets/workshop-shared/external-message-gateway").ExternalMessageGateway &
        Rpc.WorkerEntrypointBranded>;
    // The Workshop's Overseer DO namespace (see wrangler.jsonc); used only to derive ids.
    WORKSHOP_OVERSEER: DurableObjectNamespace;
  }
}

interface ExecutionContext<Props = unknown> {
  readonly exports: Cloudflare.Exports;
}

interface DurableObjectState<Props = unknown> {
  readonly exports: Cloudflare.Exports;
}
