// Configuring built-in gatekeepers.
//
//   pnpm exec alchemy deploy ./examples/1-builtin-gatekeepers/alchemy.run.ts
//
// Requires GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET in the environment
// (create the OAuth app with callback <os url>/gatekeeper/github/oauth).
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import { OperatingSystem } from "cloudflare-os";
import {
  Context,
  GitHub,
  HomeAssistant,
  Mcp,
} from "cloudflare-os/gatekeepers";

export default Alchemy.Stack(
  "BuiltinGatekeepersExample",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const os = yield* OperatingSystem("OS", {
      admins: ["admin"],
      // Sign in with GitHub, and turn password accounts off.
      auth: { gatekeepers: ["github"], disablePasswordAuth: true },
      gatekeepers: [
        // Credentialed gatekeepers install by being configured. The entry,
        // compat flags, and Durable Objects all derive from the package's
        // wrangler.jsonc at deploy time — this is the whole configuration.
        GitHub({
          clientId: Config.string("GITHUB_CLIENT_ID"),
          clientSecret: Config.redacted("GITHUB_CLIENT_SECRET"),
        }),

        // `context`, `scheduler`, and `mcp` deploy by default. Reconfigure
        // a default by listing it (same name replaces it)…
        Context({ sharingDomain: "production" }),
        // …or opt out entirely.
        Mcp({ enabled: false }),

        // Config-free but non-default gatekeepers opt in by being listed.
        HomeAssistant(),
      ],
    });

    return { url: os.url };
  }),
);
