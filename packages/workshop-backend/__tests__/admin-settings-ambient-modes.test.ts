import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { AdminSettings } from "../src/admin-settings.js";
import { ambientGatekeeperMode } from "../src/provisioning-policy.js";
import type { UserDirectoryDurableObject } from "../src/user-directory.js";

declare module "cloudflare:workers" {
  interface ProvidedEnv {
    TEST_USER_DIRECTORY: DurableObjectNamespace<UserDirectoryDurableObject>;
  }
}

const AMBIENT_VENDOR = { describe: async () => ({ autoProvisionsAccount: true }) };

describe("AdminSettings ambient gatekeeper modes", () => {
  it("default Web Search to enabled and the others to optional, until the admin sets one",
      async () => {
    // Built by hand to run with fake vendor bindings; an unrelated Durable Object lends it storage.
    const stub = env.TEST_USER_DIRECTORY.getByName("admin-settings-ambient-modes");
    const settingsEnv = {
      BLUEPRINTS: { put: async () => {} },
      GATEKEEPER_WEBSEARCH: AMBIENT_VENDOR,
      GATEKEEPER_SCHEDULER: AMBIENT_VENDOR,
    };
    await runInDurableObject(stub, async (_host, state) => {
      const admin = new AdminSettings(state, settingsEnv as unknown as Cloudflare.Env);
      const modes = () => ["websearch", "scheduler"].map(
          vendorId => ambientGatekeeperMode(admin.getAdminConfig(), vendorId));
      expect(modes()).toEqual(["enabled", "optional"]);

      await admin.setGatekeeperMode("websearch", "optional");
      await admin.setGatekeeperMode("scheduler", "enabled");
      expect(modes()).toEqual(["optional", "enabled"]);
    });
  });
});
