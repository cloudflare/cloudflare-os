import {
  DEFAULT_GATEKEEPER_WRANGLER, OBSERVABILITY, defineGadgetsWorker, type DurableObjectMigration,
} from "@gadgets/scripts/worker-config";

export default defineGadgetsWorker({
  name: "gatekeeper-unifi",
  entrypoint: ".wrangler/validate/src/unifi.ts",

  // `global_fetch_strictly_public` keeps a user-supplied console URL from reaching private
  // addresses on Cloudflare's network, where a "direct" connection therefore has to go through a
  // public hostname such as a Cloudflare Tunnel. It is checked after DNS resolution, so a public
  // name that resolves to a private address is refused too. `wrangler dev` (and so `pnpm run-local`)
  // permits any address, which is what lets a self-hosted deployment reach a console on its LAN.
  compatibilityFlags: ["allow_irrevocable_stub_storage", "global_fetch_strictly_public"],
  observability: OBSERVABILITY,
});

export const wrangler = DEFAULT_GATEKEEPER_WRANGLER;

export const migrations: DurableObjectMigration[] = [
  { tag: "v0", new_sqlite_classes: ["UnifiAccount", "UnifiGatekeeper"] },
];
