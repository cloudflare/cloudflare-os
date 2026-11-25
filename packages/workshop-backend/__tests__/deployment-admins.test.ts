import { describe, expect, it } from "vitest";
import { isDeploymentAdmin, sameDeploymentAdmin } from "../src/auth/config.js";

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

  it("never takes an empty or absent name for an admin", () => {
    let env = withAdmins([""]);
    expect(isDeploymentAdmin(env, "")).toBe(false);
    expect(isDeploymentAdmin(env, undefined)).toBe(false);
  });

  it("names no admin while the binding is unset, and refuses one that is not a list", () => {
    expect(isDeploymentAdmin(withAdmins(undefined), "admin")).toBe(false);
    expect(() => isDeploymentAdmin(withAdmins(JSON.stringify({ admin: true })), "admin"))
        .toThrow("ADMINS must be configured as an array of usernames.");
  });
});

describe("sameDeploymentAdmin", () => {
  it("takes equal names, and names that differ only by the case of ASCII letters, for one admin",
      () => {
    expect(sameDeploymentAdmin("alice@example.com", "alice@example.com")).toBe(true);
    expect(sameDeploymentAdmin("alice@example.com", "Alice@Example.COM")).toBe(true);
    expect(sameDeploymentAdmin("Alice@Example.COM", "alice@example.com")).toBe(true);
    expect(sameDeploymentAdmin("alice@example.com", "grace@example.com")).toBe(false);
  });

  it("matches exactly the names isDeploymentAdmin() matches against one entry", () => {
    let env = withAdmins(["kim@example.com"]);
    for (let name of ["kim@example.com", "Kim@example.com", "KIM@EXAMPLE.COM", "kim@example.org"]) {
      expect(sameDeploymentAdmin(name, "kim@example.com")).toBe(isDeploymentAdmin(env, name));
    }
  });

  it("folds only ASCII letters, so a look-alike name is another admin", () => {
    // The Kelvin sign lowercases to "k" under toLowerCase().
    expect("\u212Aim@example.com".toLowerCase()).toBe("kim@example.com");
    expect(sameDeploymentAdmin("\u212Aim@example.com", "kim@example.com")).toBe(false);
  });
});
