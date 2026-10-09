import {
  DEFAULT_GATEKEEPER_WRANGLER, OBSERVABILITY, bindings, defineGadgetsWorker,
  type DurableObjectMigration,
} from "@gadgets/scripts/worker-config";

export default defineGadgetsWorker({
  name: "gatekeeper-mcp",
  entrypoint: ".wrangler/validate/src/mcp.ts",

  // `global_fetch_strictly_public` is the real SSRF boundary for this Worker. Endpoints here are
  // user-supplied, and the hostname blocklist in `endpoint.ts` cannot see through a public hostname
  // that resolves (or rebinds) to a private address. This flag makes workerd reject reserved ranges
  // -- loopback, RFC1918, link-local, cloud metadata -- *after* DNS resolution, which is the only
  // place the check can be sound. The blocklist stays as a fast, legible rejection at connect time.
  //
  // `wrangler dev` reconfigures its global outbound to permit any address, so this takes effect in
  // production only; that is what keeps `MCP_ALLOW_INSECURE` usable against a localhost server.
  compatibilityFlags: ["allow_irrevocable_stub_storage", "global_fetch_strictly_public"],

  env: {
    // Set to "true" to permit http:// and private-network endpoints. Local development only.
    MCP_ALLOW_INSECURE: bindings.text("false"),
  },

  observability: OBSERVABILITY,
});

export const wrangler = DEFAULT_GATEKEEPER_WRANGLER;

export const migrations: DurableObjectMigration[] = [
  { tag: "v0", new_sqlite_classes: ["McpAccount", "McpGatekeeperImpl"] },
];
