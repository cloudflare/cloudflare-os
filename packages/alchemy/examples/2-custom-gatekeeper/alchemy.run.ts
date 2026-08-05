// A custom gatekeeper deployed as its own Worker and wired into the OS.
// The Worker (./src/worker.ts) implements the real gatekeeper contract —
// the `GatekeeperVendor` entrypoint plus the account/verifier/resource
// capability classes.
//
//   pnpm exec alchemy deploy ./examples/2-custom-gatekeeper/alchemy.run.ts
//
// Requires ACME_API_TOKEN in the environment.
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { Gatekeeper, OperatingSystem } from "cloudflare-os";

/** Cache for upstream Acme API responses. */
export const Cache = Cloudflare.KV.Namespace("Cache");

/**
 * The gatekeeper Worker. Bindings are declared on `env` and `InferEnv`
 * derives the runtime type, so the handlers can never drift from the
 * infrastructure. `AcmeThing` is the per-resource Durable Object class the
 * account mints via `ctx.exports` — declaring it here drives its SQLite
 * migration.
 */
export const AcmeWorker = Cloudflare.Worker("AcmeWorker", {
  main: "./src/worker.ts",
  compatibility: { date: "2026-02-02", flags: ["enable_ctx_exports"] },
  env: {
    CACHE: Cache,
    ACME_API_TOKEN: Config.redacted("ACME_API_TOKEN"),
    AcmeThing: Cloudflare.DurableObject("AcmeThing"),
  },
});

/**
 * The Worker's typed env. `BASE_URL` is added by the OperatingSystem
 * composite (every gatekeeper receives `<os url>/gatekeeper/<name>`), so it
 * is declared here rather than inferred.
 */
export type AcmeEnv = Cloudflare.InferEnv<typeof AcmeWorker> & {
  BASE_URL: string;
};

export default Alchemy.Stack(
  "CustomGatekeeperExample",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const worker = yield* AcmeWorker;

    const os = yield* OperatingSystem("OS", {
      admins: ["admin"],
      gatekeepers: [
        // Wires the Worker into the OS: GATEKEEPER_ACME service bindings on
        // the router (default entrypoint, HTTP) and the backend
        // (`GatekeeperVendor` entrypoint, capability RPC), plus BASE_URL.
        Gatekeeper({ name: "acme", worker }),
      ],
    });

    return { url: os.url, gatekeeper: worker.url };
  }),
);
