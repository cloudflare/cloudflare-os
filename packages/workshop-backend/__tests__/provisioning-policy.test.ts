import { describe, expect, it } from "vitest";
import { ADMIN_GATEKEEPER_VENDOR_ID } from "@gadgets/workshop-shared/admin-agent";
import {
  ambientGatekeeperMode, defaultAmbientGatekeeperMode, shouldAutoProvisionAccount,
} from "../src/provisioning-policy.js";
import { DEFAULT_ADMIN_CONFIG } from "../src/storage-schema/admin-settings-storage.js";

const config = (modes: Record<string, "disabled" | "optional" | "enabled">) =>
    ({ ...DEFAULT_ADMIN_CONFIG, ambientGatekeeperModes: modes });

describe("the mode of an auto-provisioning gatekeeper", () => {
  it("is disabled for the admin gatekeeper and optional for any other until an admin sets one", () => {
    expect(defaultAmbientGatekeeperMode(ADMIN_GATEKEEPER_VENDOR_ID)).toBe("disabled");
    expect(defaultAmbientGatekeeperMode("context")).toBe("optional");

    expect(ambientGatekeeperMode(DEFAULT_ADMIN_CONFIG, ADMIN_GATEKEEPER_VENDOR_ID)).toBe("disabled");
    expect(ambientGatekeeperMode(DEFAULT_ADMIN_CONFIG, "context")).toBe("optional");
    expect(shouldAutoProvisionAccount(DEFAULT_ADMIN_CONFIG, ADMIN_GATEKEEPER_VENDOR_ID)).toBe(false);
  });

  it("is the stored mode once an admin has set one", () => {
    let stored = config({ [ADMIN_GATEKEEPER_VENDOR_ID]: "optional", context: "disabled" });
    expect(ambientGatekeeperMode(stored, ADMIN_GATEKEEPER_VENDOR_ID)).toBe("optional");
    expect(ambientGatekeeperMode(stored, "context")).toBe("disabled");

    let forced = config({ [ADMIN_GATEKEEPER_VENDOR_ID]: "enabled" });
    expect(shouldAutoProvisionAccount(forced, ADMIN_GATEKEEPER_VENDOR_ID)).toBe(true);
  });

  it("names the vendor in any case", () => {
    let upper = ADMIN_GATEKEEPER_VENDOR_ID.toUpperCase();
    expect(defaultAmbientGatekeeperMode(upper)).toBe("disabled");
    expect(ambientGatekeeperMode(DEFAULT_ADMIN_CONFIG, upper)).toBe("disabled");
    expect(ambientGatekeeperMode(config({ [ADMIN_GATEKEEPER_VENDOR_ID]: "enabled" }), upper))
        .toBe("enabled");
    expect(ambientGatekeeperMode(DEFAULT_ADMIN_CONFIG, "Context")).toBe("optional");
  });
});
