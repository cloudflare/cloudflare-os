import { describe, expect, it } from "vitest";
import { isDeploymentAdmin } from "../src/auth/config.js";

const withAdmins = (admins: unknown) => ({ ADMINS: admins }) as unknown as Cloudflare.Env;

describe("isDeploymentAdmin", () => {
  it("matches a listed name regardless of case", () => {
    let env = withAdmins(["Jane.Doe@Example.com", "admin"]);
    expect(isDeploymentAdmin(env, "jane.doe@example.com")).toBe(true);
    expect(isDeploymentAdmin(env, "JANE.DOE@EXAMPLE.COM")).toBe(true);
    expect(isDeploymentAdmin(env, "Admin")).toBe(true);
    expect(isDeploymentAdmin(env, "someone@example.com")).toBe(false);
  });

  it("folds only ASCII letters, so a look-alike character matches no admin", () => {
    // The Kelvin sign lowercases to "k" under toLowerCase().
    let env = withAdmins(["kim@example.com"]);
    expect(isDeploymentAdmin(env, "\u212Aim@example.com")).toBe(false);
    expect(isDeploymentAdmin(env, "Kim@example.com")).toBe(true);
  });

  it("reads a list given as a JSON string", () => {
    let env = withAdmins(JSON.stringify(["Admin@Example.com"]));
    expect(isDeploymentAdmin(env, "admin@example.com")).toBe(true);
  });

  it("names no admin while the binding is unset, and refuses one that is not a list", () => {
    expect(isDeploymentAdmin(withAdmins(undefined), "admin")).toBe(false);
    expect(() => isDeploymentAdmin(withAdmins(JSON.stringify({ admin: true })), "admin"))
        .toThrow("ADMINS must be configured as an array of usernames.");
  });
});
