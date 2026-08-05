// Deploy this checkout of Cloudflare OS to your Cloudflare account:
//
//   pnpm --dir packages/alchemy run deploy
//
// Configuration comes from the environment (a `.env` works too):
//   - GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET     (optional: GitHub gatekeeper + sign-in)
//   - ANTHROPIC_API_KEY                           (optional: AI gateway stored key)
//   - OS_DOMAIN                                   (optional: custom domain on the router)
//
// With nothing configured this still deploys a fully working OS (password
// auth, BYOK model keys, the default-on gatekeepers) at the router's
// workers.dev URL.
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { OperatingSystem, type GatekeeperDeployment } from "cloudflare-os";
import { GitHub } from "cloudflare-os/gatekeepers";

export default Alchemy.Stack(
  "CloudflareOS",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* () {
    const domain = Option.getOrUndefined(
      yield* Config.option(Config.string("OS_DOMAIN")),
    );
    const github = Option.getOrUndefined(
      yield* Config.option(Config.string("GITHUB_CLIENT_ID")),
    );
    const anthropic = Option.getOrUndefined(
      yield* Config.option(Config.redacted("ANTHROPIC_API_KEY")),
    );

    const gatekeepers: GatekeeperDeployment[] = [];
    if (github !== undefined) {
      gatekeepers.push(
        GitHub({
          clientId: github,
          clientSecret: yield* Config.redacted("GITHUB_CLIENT_SECRET"),
        }),
      );
    }

    const os = yield* OperatingSystem("OS", {
      domain,
      admins: ["admin"],
      auth: github !== undefined ? { gatekeepers: ["github"] } : undefined,
      gatekeepers,
      ai: anthropic !== undefined ? { providers: { anthropic } } : undefined,
    });

    return { url: os.url };
  }),
);
